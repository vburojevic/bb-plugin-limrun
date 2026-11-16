/**
 * Limrun for bb: backend entry. Wires the service in src/ to bb's events,
 * RPC, realtime, CLI and a background sweep.
 *
 * What it does, in one place:
 * - a thread's Limrun devices are the instances labeled `bb-thread=<thread>`;
 * - the side panel streams them and can start an iPhone or iPad;
 * - the `lim` shim (opt-in) labels the devices agents create and reports
 *   their remote Xcode builds and tests, which show above the composer;
 * - archiving or deleting a thread stops its devices, and a sweep catches any
 *   archive that happened while the plugin was not loaded.
 */
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";

import type { ThreadState } from "./src/cleanup";
import { limrunCli } from "./src/cli";
import { CHANGED_CHANNEL, rpcContract } from "./src/contract";
import { defaultKeyEnvironment, resolveApiKey } from "./src/key";
import { LimrunFailure, createLimrunGateway } from "./src/limrun";
import { readRunLog } from "./src/logs";
import { MIGRATIONS, createRunStore } from "./src/runs";
import { createService } from "./src/service";
import { isRunLogPath, shimPaths, shimStatus } from "./src/shim";

export { rpcContract } from "./src/contract";
export type { DeviceDto, RunDto, UsageDto } from "./src/contract";

const SWEEP_EVERY_MS = 15 * 60_000;
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
  bb.storage.migrate(db, MIGRATIONS);
  const dataDir = dirname(db.name);
  const paths = shimPaths(dataDir);

  let installId = await bb.storage.kv.get<string>("install-id");
  if (typeof installId !== "string" || installId.length === 0) {
    installId = `bbi-${randomBytes(6).toString("hex")}`;
    await bb.storage.kv.set("install-id", installId);
  }

  const format = (message: string, data?: Record<string, unknown>) =>
    data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  const log = {
    info: (message: string, data?: Record<string, unknown>) => bb.log.info(format(message, data)),
    warn: (message: string, data?: Record<string, unknown>) => bb.log.warn(format(message, data)),
  };

  const runs = createRunStore(db);
  const keyEnvironment = defaultKeyEnvironment();

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
    publish: (threadId) => bb.realtime.publish(CHANGED_CHANNEL, { threadId }),
    log,
  });

  bb.rpc.register(rpcContract, {
    async overview() {
      const [connection, shim] = await Promise.all([service.connection(), shimStatus(paths)]);
      return {
        ...connection,
        shim: { installed: shim.installed, current: shim.current, pathLine: shim.pathLine },
      };
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
      const path = runs.logPath(threadId, runId);
      return path === null ? { text: "No log was kept for this run.", truncated: false } : readRunLog(path, runId);
    },
    org: async () => ({ ...(await service.orgOverview()), installId }),
  });

  bb.cli.register(limrunCli({ service, shimPaths: paths, installId }));

  const onGone = (reason: string) => async ({ thread }: { thread: { id: string } }) => {
    try {
      await service.threadGone(thread.id, reason);
    } catch (cause) {
      log.warn("could not stop a thread's devices", {
        threadId: thread.id,
        reason,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  bb.events.on("thread.archived", onGone("thread archived"));
  bb.events.on("thread.deleted", onGone("thread deleted"));

  // bb does not replay events missed while the plugin was unloaded, so sweep
  // at start and then every 15 minutes. Also forget runs older than 14 days.
  bb.background.service("sweep", {
    async start(signal) {
      await sleep(10_000, signal);
      while (!signal.aborted) {
        try {
          if ((await resolveApiKey(keyEnvironment)) !== null) await service.sweep();
        } catch (cause) {
          log.warn("sweep failed", { error: cause instanceof Error ? cause.message : String(cause) });
        }
        for (const { id, logPath } of runs.prune(Date.now() - KEEP_RUNS_MS)) {
          if (isRunLogPath(logPath, id)) await rm(logPath, { force: true }).catch(() => {});
        }
        await sleep(SWEEP_EVERY_MS, signal);
      }
    },
  });
}
