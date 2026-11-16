/**
 * The server-side build follower, against the fake gateway.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createBuildFollower, exitCodeOf, kindOf } from "../src/builds";
import type { BuildState } from "../src/limrun";
import { MIGRATIONS, createRunStore } from "../src/runs";
import { createFakeGateway, stored } from "./fake-gateway";

function setup() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const runs = createRunStore(db);
  const fake = createFakeGateway([stored({ id: "xcode_sb", labels: { "bb-thread": "thr_one", "bb-install": "me" } })]);
  const published: string[] = [];
  const follower = createBuildFollower({
    gateway: async () => fake.gateway,
    runs,
    sandboxes: async () => [(await fake.gateway.get("xcode", "xcode_sb"))!],
    publish: (threadId) => published.push(threadId),
    log: { info() {}, warn() {} },
    pollMs: 10,
  });
  return { runs, fake, follower, published };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("build follower", () => {
  it("ignores a build that finished before it started watching", async () => {
    const { runs, fake, follower } = setup();
    fake.builds.set("xcode_sb", { state: { execId: "build-1", status: "SUCCEEDED", exitCode: 0 } });
    await follower.refresh();
    await wait(50);
    follower.stop();
    expect(runs.forThread("thr_one")).toEqual([]);
  });

  it("records a running build from its first line to its verdict", async () => {
    const { runs, fake, follower } = setup();
    fake.builds.set("xcode_sb", { state: { execId: "build-0", status: "SUCCEEDED", exitCode: 0 } });
    await follower.refresh();
    await wait(30);
    let finish!: (state: BuildState) => void;
    fake.builds.set("xcode_sb", {
      state: { execId: "build-2", status: "RUNNING", exitCode: null },
      // One line per event, without newlines, as Limrun sends them.
      events: [
        { type: "stdout", data: "Compiling Hello.swift" },
        { type: "stderr", data: "error: missing return" },
        { type: "stdout", data: "Tip: use snapshots" },
      ],
      finish: new Promise((resolve) => (finish = resolve)),
    });
    await wait(60);
    const running = runs.forThread("thr_one")[0]!;
    expect(running).toMatchObject({ id: "build-2", status: "running", kind: "build" });
    expect(runs.sandboxOf("thr_one", "build-2")).toBe("xcode_sb");
    finish({ execId: "build-2", status: "FAILED", exitCode: 65 });
    await wait(30);
    follower.stop();
    const done = runs.get("thr_one", "build-2")!;
    expect(done.status).toBe("failed");
    expect(done.exitCode).toBe(65);
    expect(done.lastLine).toBe("error: missing return");
    // Limrun's own times, not the moment bb noticed the build.
    expect(done.endedAt! - done.startedAt).toBe(6_500);
  });

  it("records a fast build that finished between two polls", async () => {
    const { runs, fake, follower } = setup();
    fake.builds.set("xcode_sb", { state: { execId: "build-0", status: "SUCCEEDED", exitCode: 0 } });
    await follower.refresh();
    await wait(30);
    fake.builds.set("xcode_sb", { state: { execId: "test-3", status: "SUCCEEDED", exitCode: 0 } });
    await wait(50);
    follower.stop();
    expect(runs.get("thr_one", "test-3")).toMatchObject({ status: "passed", kind: "test" });
  });

  it("maps Limrun's verdicts to exit codes", () => {
    expect(kindOf("test-123")).toBe("test");
    expect(kindOf("build-123")).toBe("build");
    expect(exitCodeOf({ execId: "a", status: "SUCCEEDED", exitCode: null })).toBe(0);
    expect(exitCodeOf({ execId: "a", status: "CANCELLED", exitCode: null })).toBe(130);
    expect(exitCodeOf({ execId: "a", status: "FAILED", exitCode: 65 })).toBe(65);
  });
});
