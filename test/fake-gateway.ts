import type {
  BuildEvent,
  BuildState,
  CreateIosOptions,
  Device,
  DeviceKind,
  LimrunGateway,
  StreamCredentials,
  Usage,
} from "../src/limrun";
import { MODEL_LABEL, LIVE_STATES } from "../src/limrun";
import { installOf, threadOf } from "../src/labels";

interface Stored {
  kind: DeviceKind;
  id: string;
  labels: Record<string, string>;
  state: string;
  createdAt: string;
  endedAt: string | null;
  displayName: string | null;
}

/** An in-memory Limrun with the label semantics the plugin relies on. */
export interface FakeBuild {
  state: BuildState;
  events?: BuildEvent[];
  /** Resolves a followed RUNNING build; set by the test. */
  finish?: Promise<BuildState>;
}

export function createFakeGateway(seed: Stored[] = []) {
  const store = new Map<string, Stored>(seed.map((item) => [item.id, { ...item }]));
  /** Sandbox id → its latest build, as the test scripts it. */
  const builds = new Map<string, FakeBuild>();
  const calls: string[] = [];
  let counter = 0;

  const toDevice = (item: Stored): Device => ({
    id: item.id,
    kind: item.kind,
    threadId: threadOf(item.labels),
    installId: installOf(item.labels),
    displayName: item.displayName,
    model: item.labels[MODEL_LABEL] ?? null,
    state: item.state,
    region: "eu-north1",
    createdAt: item.createdAt,
    endedAt: item.endedAt,
    terminationReason: item.state === "terminated" ? "UserRequested" : null,
    errorMessage: null,
  });

  const matches = (item: Stored, selector: string | undefined) =>
    selector === undefined ||
    selector.split(",").every((pair) => {
      const [key, value] = pair.split("=");
      return item.labels[key!] === value;
    });

  const gateway: LimrunGateway = {
    async list(kind, options = {}) {
      calls.push(`list ${kind} ${options.labelSelector ?? "*"}${options.live ? " live" : ""}`);
      return [...store.values()]
        .filter((item) => item.kind === kind)
        .filter((item) => matches(item, options.labelSelector))
        .filter((item) => !options.live || (LIVE_STATES as readonly string[]).includes(item.state))
        .map(toDevice);
    },
    async get(kind, id) {
      const item = store.get(id);
      return item === undefined || item.kind !== kind ? null : toDevice(item);
    },
    async createIos(options: CreateIosOptions) {
      counter += 1;
      const item: Stored = {
        kind: "ios",
        id: `ios_fake_${counter}`,
        labels: { ...options.labels, [MODEL_LABEL]: options.model },
        state: "ready",
        createdAt: new Date(Date.now()).toISOString(),
        endedAt: null,
        displayName: options.displayName,
      };
      store.set(item.id, item);
      calls.push(`create ${item.id}`);
      return toDevice(item);
    },
    async remove(kind, id) {
      calls.push(`remove ${kind} ${id}`);
      const item = store.get(id);
      if (item !== undefined) {
        item.state = "terminated";
        item.endedAt = new Date().toISOString();
      }
    },
    async addLabels(kind, id, labels) {
      calls.push(`label ${kind} ${id}`);
      const item = store.get(id);
      if (item === undefined) return null;
      item.labels = { ...item.labels, ...labels };
      return toDevice(item);
    },
    async stream(id): Promise<StreamCredentials | null> {
      const item = store.get(id);
      if (item === undefined || item.state !== "ready") return null;
      return { url: `wss://fake/${id}`, token: "stream-token" };
    },
    async latestBuild(sandboxId, options) {
      const build = builds.get(sandboxId);
      if (build === undefined) return null;
      if (options.execId !== undefined && options.execId !== build.state.execId) return null;
      for (const event of build.events ?? []) options.onEvent?.(event);
      if (options.follow && build.state.status === "RUNNING" && build.finish !== undefined) return build.finish;
      return build.state;
    },
    async buildLog(sandboxId, execId) {
      const build = builds.get(sandboxId);
      return build?.state.execId === execId ? (build.events ?? []).map((event) => event.data).join("") : null;
    },
    async buildTimes() {
      return { startedAt: 1_000, endedAt: 7_500 };
    },
    async usage(options): Promise<Usage> {
      const zero = { billedMinutes: 0, runtimeMinutes: 0, cost: 0, count: 0 };
      return { from: options.from, to: options.to, ios: zero, xcode: zero };
    },
  };

  return { gateway, store, calls, builds };
}

export function stored(partial: Partial<Stored> & Pick<Stored, "id">): Stored {
  return {
    kind: partial.id.startsWith("sandbox_") || partial.id.startsWith("xcode_") ? "xcode" : "ios",
    labels: {},
    state: "ready",
    createdAt: "2026-11-16T10:00:00.000Z",
    endedAt: null,
    displayName: null,
    ...partial,
  };
}
