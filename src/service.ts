/**
 * Everything the plugin does, behind one object the RPC handlers, the CLI and
 * the lifecycle events share. server.ts only wires it to bb.
 */
import { stopThreadDevices, sweep, type CleanupLog, type ThreadState } from "./cleanup";
import type { ResolvedKey } from "./key";
import { INSTALL_LABEL, THREAD_LABEL, isThreadId, ownedLabels, threadSelector } from "./labels";
import {
  LIVE_STATES,
  LimrunFailure,
  describeFailure,
  type Device,
  type DeviceKind,
  type LimrunGateway,
  type StreamCredentials,
  type Usage,
} from "./limrun";
import type { Run, RunStore } from "./runs";

export interface Connection {
  connected: boolean;
  keySource: ResolvedKey["source"] | null;
  error: string | null;
}

export interface OrgOverview {
  today: Usage | null;
  month: Usage | null;
  live: Device[];
  error: string | null;
}

export interface ServiceDeps {
  resolveKey: () => Promise<ResolvedKey | null>;
  makeGateway: (key: string) => LimrunGateway;
  runs: RunStore;
  installId: string;
  threadTitle: (threadId: string) => Promise<string | null>;
  threadState: (threadId: string) => Promise<ThreadState>;
  /** Tells open panels and cards that a thread's devices or runs changed. */
  publish: (threadId: string | null) => void;
  log: CleanupLog;
  now?: () => number;
}

const NO_KEY = "No Limrun API key yet. Paste one on bb's Limrun page.";
const DEVICE_CACHE_MS = 4_000;

function isLive(device: Device): boolean {
  return (LIVE_STATES as readonly string[]).includes(device.state);
}

function kindOfId(id: string): DeviceKind | null {
  if (id.startsWith("ios_")) return "ios";
  if (id.startsWith("sandbox_") || id.startsWith("xcode_")) return "xcode";
  return null;
}

export function createService(deps: ServiceDeps) {
  const now = deps.now ?? Date.now;
  let gatewayFor: { key: string; gateway: LimrunGateway } | null = null;
  const deviceCache = new Map<string, { at: number; devices: Device[] }>();
  const starting = new Map<string, Promise<Device>>();

  async function gateway(): Promise<LimrunGateway> {
    const resolved = await deps.resolveKey();
    if (resolved === null) throw new LimrunFailure(NO_KEY, "key-rejected");
    if (gatewayFor === null || gatewayFor.key !== resolved.key) {
      gatewayFor = { key: resolved.key, gateway: deps.makeGateway(resolved.key) };
    }
    return gatewayFor.gateway;
  }

  function changed(threadId: string | null) {
    if (threadId !== null) deviceCache.delete(threadId);
    deps.publish(threadId);
  }

  async function threadDevices(threadId: string, fresh = false): Promise<Device[]> {
    const cached = deviceCache.get(threadId);
    if (!fresh && cached !== undefined && now() - cached.at < DEVICE_CACHE_MS) return cached.devices;
    const limrun = await gateway();
    const selector = threadSelector(threadId);
    const devices = [
      ...(await limrun.list("ios", { labelSelector: selector, max: 50 })),
      ...(await limrun.list("xcode", { labelSelector: selector, max: 50 })),
    ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    deviceCache.set(threadId, { at: now(), devices });
    return devices;
  }

  async function ownedDevice(threadId: string, id: string): Promise<Device> {
    const device = (await threadDevices(threadId)).find((candidate) => candidate.id === id);
    if (device === undefined) {
      throw new LimrunFailure("That device does not belong to this thread.", "not-found");
    }
    return device;
  }

  return {
    async connection(): Promise<Connection> {
      const resolved = await deps.resolveKey();
      if (resolved === null) return { connected: false, keySource: null, error: NO_KEY };
      try {
        await (await gateway()).list("ios", { live: true, max: 1 });
        return { connected: true, keySource: resolved.source, error: null };
      } catch (cause) {
        return { connected: false, keySource: resolved.source, error: describeFailure(cause).message };
      }
    },

    async threadState(threadId: string): Promise<{ devices: Device[] }> {
      const devices = await threadDevices(threadId);
      // Live devices first, then the five most recent ended ones for context.
      return { devices: [...devices.filter(isLive), ...devices.filter((device) => !isLive(device)).slice(0, 5)] };
    },

    runs(threadId: string): Run[] {
      return deps.runs.forThread(threadId);
    },

    /** Starts the thread's simulator, or joins a start already in flight. */
    async startDevice(threadId: string, model: "iphone" | "ipad"): Promise<Device> {
      const key = `${threadId}:${model}`;
      const inFlight = starting.get(key);
      if (inFlight !== undefined) return inFlight;
      const work = (async () => {
        const title = await deps.threadTitle(threadId);
        const device = await (await gateway()).createIos({
          model,
          displayName: `bb: ${(title ?? threadId).slice(0, 60)}`,
          labels: ownedLabels(undefined, threadId, deps.installId),
        });
        deps.log.info("started device", { id: device.id, threadId, model });
        return device;
      })();
      starting.set(key, work);
      changed(threadId);
      try {
        return await work;
      } finally {
        starting.delete(key);
        changed(threadId);
      }
    },

    isStarting(threadId: string): ("iphone" | "ipad")[] {
      return (["iphone", "ipad"] as const).filter((model) => starting.has(`${threadId}:${model}`));
    },

    /** Stops one of a thread's devices. */
    async stopDevice(threadId: string, id: string): Promise<void> {
      const device = await ownedDevice(threadId, id);
      await (await gateway()).remove(device.kind, device.id);
      deps.log.info("stopped device", { id, threadId, reason: "requested" });
      changed(threadId);
    },

    /** Stops a device this bb installation labeled, from the org page or a person's terminal. */
    async stopLabeledDevice(id: string): Promise<Device> {
      const kind = kindOfId(id);
      if (kind === null) throw new LimrunFailure(`"${id}" is not a Limrun instance id.`, "not-found");
      const limrun = await gateway();
      const device = await limrun.get(kind, id);
      if (device === null) throw new LimrunFailure("That Limrun instance no longer exists.", "not-found");
      if (device.threadId === null) {
        throw new LimrunFailure("bb only stops devices labeled with a bb thread. Stop this one with lim.", "failed");
      }
      if (device.installId !== deps.installId) {
        throw new LimrunFailure("Another bb started this device. Stop it from that bb or with lim.", "failed");
      }
      await limrun.remove(kind, id);
      deps.log.info("stopped device", { id, threadId: device.threadId, reason: "requested" });
      changed(device.threadId);
      return device;
    },

    async stream(threadId: string, id: string): Promise<StreamCredentials> {
      const device = await ownedDevice(threadId, id);
      if (device.kind !== "ios") throw new LimrunFailure("Only simulators stream.", "failed");
      const credentials = await (await gateway()).stream(id);
      if (credentials === null) throw new LimrunFailure("The simulator is not ready to stream yet.", "failed");
      return credentials;
    },

    dismissRuns(threadId: string): number {
      const count = deps.runs.dismissFinished(threadId);
      deps.publish(threadId);
      return count;
    },

    /** Live Xcode sandboxes this install labeled, for the build follower. */
    async liveSandboxes(threadIds: Set<string>): Promise<Device[]> {
      if (threadIds.size === 0) return [];
      const sandboxes = await (await gateway()).list("xcode", {
        labelSelector: `${INSTALL_LABEL}=${deps.installId}`,
        live: true,
        max: 200,
      });
      return sandboxes.filter((sandbox) => sandbox.threadId !== null && threadIds.has(sandbox.threadId));
    },

    gateway,

    changed,

    async orgOverview(): Promise<OrgOverview> {
      try {
        const limrun = await gateway();
        const current = new Date(now());
        const dayStart = new Date(current);
        dayStart.setHours(0, 0, 0, 0);
        const monthStart = new Date(current.getFullYear(), current.getMonth(), 1);
        const to = current.toISOString();
        const [today, month, ios, xcode] = await Promise.all([
          limrun.usage({ from: dayStart.toISOString(), to }).catch(() => null),
          limrun.usage({ from: monthStart.toISOString(), to }).catch(() => null),
          limrun.list("ios", { live: true, max: 100 }),
          limrun.list("xcode", { live: true, max: 100 }),
        ]);
        return { today, month, live: [...ios, ...xcode], error: null };
      } catch (cause) {
        return { today: null, month: null, live: [], error: describeFailure(cause).message };
      }
    },

    /** `thread.archived` and `thread.deleted`. */
    async threadGone(threadId: string, reason: string): Promise<number> {
      if (!isThreadId(threadId)) return 0;
      const stopped = await stopThreadDevices(await gateway(), threadId, deps.log, reason);
      if (stopped > 0) changed(threadId);
      return stopped;
    },

    async sweep(): Promise<number> {
      const stopped = await sweep(await gateway(), deps.installId, deps.threadState, deps.log);
      if (stopped > 0) changed(null);
      return stopped;
    },
  };
}

export type LimrunService = ReturnType<typeof createService>;
