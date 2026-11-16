/**
 * Follows remote builds on the Xcode sandboxes of threads that build on
 * Limrun, from the bb server, so the build card needs nothing on the machine
 * the thread runs on.
 *
 * Limrun reports a sandbox's latest build through `observeBuildLogs`: asked
 * without `follow` it answers at once with that build's id and status; with
 * `follow` it streams the log and resolves with SUCCEEDED, FAILED or
 * CANCELLED and the exit code. So each watched sandbox is polled every few
 * seconds, and a new build is streamed to its verdict.
 */
import type { BuildState, Device, LimrunGateway } from "./limrun";
import type { RunKind, RunStore } from "./runs";

export interface FollowerLog {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface FollowerDeps {
  gateway(): Promise<LimrunGateway>;
  runs: RunStore;
  /** Live Xcode sandboxes of every thread that builds on Limrun. */
  sandboxes(): Promise<Device[]>;
  publish(threadId: string): void;
  log: FollowerLog;
  pollMs?: number;
  now?: () => number;
}

export function kindOf(execId: string): RunKind {
  return execId.startsWith("test") ? "test" : "build";
}

export function exitCodeOf(state: BuildState): number {
  if (state.exitCode !== null) return state.exitCode;
  if (state.status === "SUCCEEDED") return 0;
  if (state.status === "CANCELLED") return 130;
  return 1;
}

function lastLineOf(text: string): string | null {
  const lines = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line.length > 0 && !/^(Tip|Hint):/i.test(line)) return line;
  }
  return null;
}

export function createBuildFollower(deps: FollowerDeps) {
  const pollMs = deps.pollMs ?? 4_000;
  /** Sandbox id → the follower's stop switch. */
  const watching = new Map<string, AbortController>();
  /** Sandbox id → the last build id already handled (or seen before we started). */
  const handled = new Map<string, string>();

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });

  async function recordTimes(sandboxId: string, threadId: string, execId: string) {
    const times = await (await deps.gateway()).buildTimes(sandboxId, execId);
    if (times !== null) deps.runs.setTimes(threadId, execId, times.startedAt, times.endedAt);
  }

  /** Streams one running build to its end, writing the run as it goes. */
  async function stream(sandbox: Device, threadId: string, state: BuildState, signal: AbortSignal) {
    const limrun = await deps.gateway();
    deps.runs.start({ id: state.execId, threadId, kind: kindOf(state.execId), command: `lim xcode ${kindOf(state.execId)}`});
    deps.runs.setSandbox(threadId, state.execId, sandbox.id);
    deps.publish(threadId);
    let pending = "";
    let lastPublished = 0;
    const final = await limrun.latestBuild(sandbox.id, {
      execId: state.execId,
      follow: true,
      signal,
      onEvent: (event) => {
        if (event.type !== "stdout" && event.type !== "stderr") return;
        // Limrun sends one log line per event, usually without its newline.
        pending = (pending + (event.data.endsWith("\n") ? event.data : `${event.data}\n`)).slice(-4_096);
        const now = (deps.now ?? Date.now)();
        if (now - lastPublished < 2_000) return;
        lastPublished = now;
        const line = lastLineOf(pending);
        if (line !== null) {
          deps.runs.progress(threadId, state.execId, line);
          deps.publish(threadId);
        }
      },
    });
    if (signal.aborted) return;
    const done = final ?? { ...state, status: "FAILED" as const };
    deps.runs.end(threadId, state.execId, exitCodeOf(done), lastLineOf(pending));
    await recordTimes(sandbox.id, threadId, state.execId);
    handled.set(sandbox.id, state.execId);
    deps.publish(threadId);
    deps.log.info("build finished", { threadId, sandbox: sandbox.id, execId: state.execId, status: done.status });
  }

  async function follow(sandbox: Device, signal: AbortSignal) {
    const threadId = sandbox.threadId!;
    let first = true;
    while (!signal.aborted) {
      try {
        const limrun = await deps.gateway();
        const state = await limrun.latestBuild(sandbox.id, { follow: false, signal });
        if (state !== null && handled.get(sandbox.id) !== state.execId) {
          if (state.status === "RUNNING") {
            await stream(sandbox, threadId, state, signal);
          } else if (first) {
            // A build bb was streaming when it last stopped (a reload, a
            // restart, the switch flipped) gets its verdict now; one built
            // before bb ever watched is not this card's news.
            if (deps.runs.get(threadId, state.execId)?.endedAt === null) {
              deps.runs.end(threadId, state.execId, exitCodeOf(state), null);
              await recordTimes(sandbox.id, threadId, state.execId);
              deps.publish(threadId);
            }
            handled.set(sandbox.id, state.execId);
          } else {
            // Finished between two polls (a fast build): record it whole.
            deps.runs.start({ id: state.execId, threadId, kind: kindOf(state.execId), command: `lim xcode ${kindOf(state.execId)}`});
            deps.runs.setSandbox(threadId, state.execId, sandbox.id);
            deps.runs.end(threadId, state.execId, exitCodeOf(state), null);
            await recordTimes(sandbox.id, threadId, state.execId);
            handled.set(sandbox.id, state.execId);
            deps.publish(threadId);
          }
        }
      } catch (cause) {
        deps.log.warn("build follow failed", {
          sandbox: sandbox.id,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      first = false;
      await sleep(pollMs, signal);
    }
  }

  return {
    /** Starts following new sandboxes and stops following ended ones. */
    async refresh(): Promise<void> {
      const live = await deps.sandboxes();
      const liveIds = new Set(live.map((sandbox) => sandbox.id));
      for (const [id, controller] of watching) {
        if (!liveIds.has(id)) {
          controller.abort();
          watching.delete(id);
        }
      }
      for (const sandbox of live) {
        if (watching.has(sandbox.id) || sandbox.threadId === null) continue;
        const controller = new AbortController();
        watching.set(sandbox.id, controller);
        void follow(sandbox, controller.signal).finally(() => {
          if (watching.get(sandbox.id) === controller) watching.delete(sandbox.id);
        });
      }
    },

    stop(): void {
      for (const controller of watching.values()) controller.abort();
      watching.clear();
    },
  };
}

export type BuildFollower = ReturnType<typeof createBuildFollower>;
