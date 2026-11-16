// @vitest-environment jsdom
/**
 * The build card, rendered by the SDK's own slot harness with a fake RPC.
 */
import { act } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunsBanner } from "../app/RunsBanner";

installTestPluginRuntime();

const LOST_AFTER_MS = 20 * 60 * 1000;

function run(threadId: string, command: string, at: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `run_${threadId.slice(4)}`,
    threadId,
    kind: "build",
    command,
    startedAt: at,
    endedAt: null,
    exitCode: null,
    status: "running",
    lastLine: null,
    lastActivityAt: at,
    dismissed: false,
    ...overrides,
  };
}

const settle = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("build card", () => {
  it("shows the new thread's runs when the thread changes during a fetch", async () => {
    const calls: string[] = [];
    const view = renderSlot({ component: RunsBanner }, {}, {
      composer: { scope: { kind: "thread", threadId: "thr_a" } as never },
      rpc: {
        thread_runs: async ({ threadId }: { threadId: string }) => {
          calls.push(threadId);
          await new Promise((resolve) => setTimeout(resolve, threadId === "thr_a" ? 200 : 0));
          return { runs: threadId === "thr_a" ? [run("thr_a", "lim xcode build THREAD-A-ONLY", Date.now())] : [] };
        },
      } as never,
    });
    await settle(20);
    await view.setComposerScope({ kind: "thread", threadId: "thr_b" } as never);
    await settle(400);
    expect(calls).toContain("thr_b");
    expect(view.container.textContent ?? "").not.toContain("THREAD-A-ONLY");
  });

  it("stops claiming a build runs once bb has stopped hearing from it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const started = Date.now();
    const view = renderSlot({ component: RunsBanner }, {}, {
      composer: { scope: { kind: "thread", threadId: "thr_q" } as never },
      rpc: {
        // The server works the status out from the clock when it answers.
        thread_runs: async () => {
          const quiet = Date.now() - started > LOST_AFTER_MS;
          return { runs: [run("thr_q", "lim xcode build .", started, quiet ? { status: "lost" } : {})] };
        },
      } as never,
    });
    await settle(50);
    expect(view.container.textContent).toContain("Building on Limrun");
    // 25 quiet minutes: no longer "Building", shown as lost and dismissable.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    });
    await settle(50);
    expect(view.container.textContent).not.toContain("Building on Limrun");
    expect(view.container.textContent).toContain("lost track");
    // 45 quiet minutes: gone, like any finished run after 30 minutes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    });
    await settle(50);
    expect(view.container.textContent).toBe("");
  });
});
