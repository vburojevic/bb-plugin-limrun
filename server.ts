/**
 * Limrun for bb: backend entry. Wires the modules in src/ to bb.
 *
 * - A thread's Limrun devices are the instances labeled `bb-thread=<thread>`.
 *   The Limrun tab streams them; archiving or deleting the thread stops them,
 *   and a sweep catches archives the plugin missed while unloaded.
 * - Build on Limrun is a per-thread switch. In a thread with it on, bb hands
 *   the agent (any provider, any machine) an environment that points `lim` at
 *   this server's proxy, plus instructions to build, test and run iOS targets
 *   only there. The proxy adds the API key and the thread's labels, so the key
 *   never leaves the server.
 * - The server follows those threads' remote builds itself, for the card
 *   above the composer.
 */
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";

import { CAPS, PROVIDER_IDS, agentEnv, agentInstructions } from "./src/agent";
import { createBuildFollower } from "./src/builds";
import type { ThreadState } from "./src/cleanup";
import { limrunCli } from "./src/cli";
import { CHANGED_CHANNEL, rpcContract } from "./src/contract";
import { defaultKeyEnvironment, resolveApiKey } from "./src/key";
import { LimrunFailure, createLimrunGateway, describeFailure } from "./src/limrun";
import { MODE_MIGRATIONS, PENDING_FOR_MS, createModeStore } from "./src/mode";
import { PROXY_ROUTE, handleProxy, signThreadToken, verifyThreadToken } from "./src/proxy";
import { MIGRATIONS, createRunStore } from "./src/runs";
import { createService } from "./src/service";

export { rpcContract } from "./src/contract";
export type { DeviceDto, RunDto, UsageDto } from "./src/contract";

const SWEEP_EVERY_MS = 15 * 60_000;
const FOLLOW_REFRESH_MS = 30_000;
const KEEP_RUNS_MS = 14 * 24 * 60 * 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function refuse(cause: unknown): never {
  if (cause instanceof experimental_PluginRpcRefusal) throw cause;
  if (cause instanceof LimrunFailure) {
    throw new experimental_PluginRpcRefusal({
      code: cause.code === "not-found" ? "not_found" : "invalid",
      message: cause.message,
    });
  }
  throw cause;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    refuse(cause);
  }
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  // Order is permanent: run migrations first (v0.1 shipped the first three).
  bb.storage.migrate(db, [...MIGRATIONS.slice(0, 3), ...MODE_MIGRATIONS, ...MIGRATIONS.slice(3)]);

  // v0.1 put a lim shim in the data dir; v0.2 retires it.
  await rm(join(dirname(db.name), "shim"), { recursive: true, force: true }).catch(() => {});

  const format = (message: string, data?: Record<string, unknown>) =>
    data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  const log = {
    info: (message: string, data?: Record<string, unknown>) => bb.log.info(format(message, data)),
    warn: (message: string, data?: Record<string, unknown>) => bb.log.warn(format(message, data)),
  };

  let installId = await bb.storage.kv.get<string>("install-id");
  if (typeof installId !== "string" || installId.length === 0) {
    installId = `bbi-${randomBytes(6).toString("hex")}`;
    await bb.storage.kv.set("install-id", installId);
  }
  let proxySecret = await bb.storage.kv.get<string>("proxy-secret");
  if (typeof proxySecret !== "string" || proxySecret.length < 32) {
    proxySecret = randomBytes(32).toString("hex");
    await bb.storage.kv.set("proxy-secret", proxySecret);
  }
  const secret = proxySecret;

  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      secret: true,
      label: "Limrun API key",
      description: "From console.limrun.com, Settings, API Keys. Kept on the bb server; agents and browsers never see it.",
    },
  });
  const keyEnvironment = defaultKeyEnvironment(async () => (await settings.get()).apiKey ?? null);
  const currentKey = async () => (await resolveApiKey(keyEnvironment))?.key ?? null;

  const runs = createRunStore(db);
  const modes = createModeStore(db);
  const publish = (threadId: string | null) => bb.realtime.publish(CHANGED_CHANNEL, { threadId });

  async function threadState(threadId: string): Promise<ThreadState> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread.archivedAt === null ? "open" : "archived";
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return /404|not found/i.test(message) ? "gone" : "unknown";
    }
  }

  const service = createService({
    resolveKey: () => resolveApiKey(keyEnvironment),
    makeGateway: createLimrunGateway,
    runs,
    installId,
    threadTitle: async (threadId) => {
      try {
        return (await bb.sdk.threads.get({ threadId })).title ?? null;
      } catch {
        return null;
      }
    },
    threadState,
    publish,
    log,
  });

  const follower = createBuildFollower({
    gateway: service.gateway,
    runs,
    sandboxes: () => service.liveSandboxes(new Set(modes.onThreads())),
    publish,
    log,
  });
  const refreshFollower = () => void follower.refresh().catch(() => {});
  bb.onDispose(() => follower.stop());

  // The proxy every Build on Limrun thread's lim talks to. Exact-path routes
  // only, so the Limrun path rides in ?p= (see src/proxy.ts).
  const proxyDeps = {
    apiKey: currentKey,
    installId,
    isOn: (threadId: string) => modes.isOn(threadId),
    verifyToken: (token: string) => verifyThreadToken(secret, token),
    changed: (threadId: string) => {
      service.changed(threadId);
      refreshFollower();
    },
    caps: CAPS,
    log,
  };
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    bb.http.route(method, PROXY_ROUTE, (context) => handleProxy(context.req.raw, proxyDeps), { auth: "none" });
  }

  // The agent's environment and instructions, for threads that build on Limrun.
  const contributeEnv = bb.providers?.experimental_contributeEnv;
  if (typeof contributeEnv === "function") {
    for (const providerId of PROVIDER_IDS) {
      try {
        contributeEnv.call(bb.providers, providerId, (context) =>
          context.threadId !== null && modes.isOn(context.threadId)
            ? agentEnv(bb.pluginId, context.threadId, signThreadToken(secret, context.threadId))
            : [],
        );
      } catch (cause) {
        log.warn("no provider environment for this provider", {
          providerId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  } else {
    log.warn("this bb offers no provider environment; Build on Limrun cannot set up lim for agents");
  }
  bb.agents.contributeInstructions(({ threadId }) =>
    threadId !== null && threadId !== undefined && modes.isOn(threadId) ? agentInstructions() : null,
  );

  // A new thread whose composer had Build on Limrun on: its project carries a
  // short-lived flag, claimed by the first message a person sends there.
  const hooks = (bb as { experimental_hooks?: BbPluginApi["experimental_hooks"] }).experimental_hooks;
  hooks?.on("message.dispatch", (context) => {
    const thread = context.thread;
    const fresh = Date.now() - thread.createdAt < PENDING_FOR_MS;
    if (
      context.attempt === "start-turn" &&
      context.initiator === "user" &&
      fresh &&
      !modes.known(thread.id) &&
      modes.claimPending(context.project.id)
    ) {
      modes.set(thread.id, true);
      log.info("build on limrun on for a new thread", { threadId: thread.id });
      publish(thread.id);
    }
    return { action: "proceed" };
  });

  bb.rpc.register(rpcContract, {
    async overview() {
      const connection = await service.connection();
      return connection;
    },
    async set_api_key({ key }) {
      try {
        await createLimrunGateway(key).list("ios", { live: true, max: 1 });
      } catch (cause) {
        return { connected: false, error: describeFailure(cause).message };
      }
      await settings.experimental_set({ apiKey: key });
      publish(null);
      return { connected: true, error: null };
    },
    async clear_api_key() {
      await settings.experimental_set({ apiKey: null });
      publish(null);
      return { cleared: true };
    },
    thread_mode: ({ threadId }) => ({ on: modes.isOn(threadId) }),
    set_thread_mode({ threadId, on }) {
      modes.set(threadId, on);
      log.info("build on limrun switched", { threadId, on });
      publish(threadId);
      refreshFollower();
      return { on };
    },
    pending_mode: ({ projectId }) => ({ on: modes.pending(projectId) }),
    set_pending_mode({ projectId, on }) {
      modes.setPending(projectId, on);
      return { on };
    },
    async thread_state({ threadId }) {
      const starting = service.isStarting(threadId);
      try {
        const state = await service.threadState(threadId);
        return { ...state, starting, error: null };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { devices: [], starting, error: message };
      }
    },
    thread_runs: ({ threadId }) => ({ runs: service.runs(threadId) }),
    start_device: ({ threadId, model }) => guarded(() => service.startDevice(threadId, model)),
    stop_device: ({ threadId, id }) =>
      guarded(async () => {
        await service.stopDevice(threadId, id);
        return { stopped: true };
      }),
    stop_labeled_device: ({ id }) =>
      guarded(async () => {
        await service.stopLabeledDevice(id);
        return { stopped: true };
      }),
    stream: ({ threadId, id }) => guarded(() => service.stream(threadId, id)),
    dismiss_runs: ({ threadId }) => ({ dismissed: service.dismissRuns(threadId) }),
    async run_log({ threadId, runId }) {
      const sandbox = runs.sandboxOf(threadId, runId);
      if (sandbox === null) return { text: "No log was kept for this run.", truncated: false };
      try {
        const text = await (await service.gateway()).buildLog(sandbox, runId);
        if (text === null) return { text: "This build's log is no longer available.", truncated: false };
        const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
        return { text: clean, truncated: text.length >= 64 * 1024 };
      } catch (cause) {
        return { text: describeFailure(cause).message, truncated: false };
      }
    },
    org: async () => ({ ...(await service.orgOverview()), installId }),
  });

  bb.cli.register(limrunCli({ service, isOn: (threadId) => modes.isOn(threadId) }));

  const onGone = (reason: string, forget: boolean) => async ({ thread }: { thread: { id: string } }) => {
    if (forget) modes.forget(thread.id);
    try {
      await service.threadGone(thread.id, reason);
    } catch (cause) {
      log.warn("could not stop a thread's devices", {
        threadId: thread.id,
        reason,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
    refreshFollower();
  };
  bb.events.on("thread.archived", onGone("thread archived", false));
  bb.events.on("thread.deleted", onGone("thread deleted", true));

  // bb does not replay events missed while the plugin was unloaded, so sweep
  // at start and then every 15 minutes. Also forget runs older than 14 days.
  bb.background.service("sweep", {
    async start(signal) {
      await sleep(10_000, signal);
      while (!signal.aborted) {
        try {
          if ((await currentKey()) !== null) await service.sweep();
        } catch (cause) {
          log.warn("sweep failed", { error: cause instanceof Error ? cause.message : String(cause) });
        }
        runs.prune(Date.now() - KEEP_RUNS_MS);
        await sleep(SWEEP_EVERY_MS, signal);
      }
    },
  });

  // Picks up sandboxes the proxy did not see created (a restart, another bb
  // window) and drops ended ones.
  bb.background.service("builds", {
    async start(signal) {
      while (!signal.aborted) {
        if ((await currentKey()) !== null) await follower.refresh().catch(() => {});
        await sleep(FOLLOW_REFRESH_MS, signal);
      }
      follower.stop();
    },
  });
}
