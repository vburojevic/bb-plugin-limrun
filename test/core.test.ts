import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { stopThreadDevices, sweep } from "../src/cleanup";
import { parseLimConfig, resolveApiKey } from "../src/key";
import { threadOf } from "../src/labels";
import { MIGRATIONS, createRunStore, statusOf, LOST_AFTER_MS } from "../src/runs";
import { createService } from "../src/service";
import { createFakeGateway, stored } from "./fake-gateway";

const quiet = { info() {}, warn() {} };

describe("API key", () => {
  it("reads lim's config line, quoted or not", () => {
    expect(parseLimConfig("api-key: lim_abc\n")).toBe("lim_abc");
    expect(parseLimConfig("other: x\napi-key: 'lim_q'\n")).toBe("lim_q");
    expect(parseLimConfig('api-key: "lim_d"')).toBe("lim_d");
    expect(parseLimConfig("api-key:\n")).toBeNull();
    expect(parseLimConfig("nothing here")).toBeNull();
  });

  it("prefers LIM_API_KEY, then lim's config, then nothing", async () => {
    const config = async () => "api-key: lim_config\n";
    expect(await resolveApiKey({ env: { LIM_API_KEY: "lim_env" }, readConfig: config })).toEqual({
      key: "lim_env",
      source: "env",
    });
    expect(await resolveApiKey({ env: {}, readConfig: config })).toEqual({ key: "lim_config", source: "lim-config" });
    expect(await resolveApiKey({ env: { LIM_API_KEY: "  " }, readConfig: async () => null })).toBeNull();
  });
});

describe("labels", () => {
  it("accepts only thread-shaped owners", () => {
    expect(threadOf({ "bb-thread": "thr_abc123" })).toBe("thr_abc123");
    expect(threadOf({ "bb-thread": "nope" })).toBeNull();
    expect(threadOf({ bb_thread: "thr_abc123" })).toBeNull();
    expect(threadOf(undefined)).toBeNull();
  });
});

describe("runs", () => {
  function store(now = { value: 1_000_000 }) {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    return { runs: createRunStore(db, () => now.value), now };
  }

  it("walks a build from start to verdict and keeps runs per thread", () => {
    const { runs, now } = store();
    runs.start({ id: "run_a", threadId: "thr_one", kind: "build", command: "lim xcode build .", logPath: null });
    expect(runs.forThread("thr_one")[0]?.status).toBe("running");
    runs.progress("thr_one", "run_a", "  Compiling   Foo.swift  ");
    expect(runs.get("thr_one", "run_a")?.lastLine).toBe("Compiling Foo.swift");
    now.value += 90_000;
    runs.end("thr_one", "run_a", 0, "** BUILD SUCCEEDED **");
    const done = runs.get("thr_one", "run_a")!;
    expect(done.status).toBe("passed");
    expect(done.endedAt! - done.startedAt).toBe(90_000);
    expect(runs.forThread("thr_two")).toEqual([]);
    // Another thread cannot end or read this run.
    expect(runs.end("thr_two", "run_a", 1, null)).toBeNull();
  });

  it("names failures, interruptions and lost runs", () => {
    expect(statusOf({ ended_at: 5, exit_code: 65, started_at: 0, last_activity_at: 5 }, 10)).toBe("failed");
    expect(statusOf({ ended_at: 5, exit_code: 130, started_at: 0, last_activity_at: 5 }, 10)).toBe("interrupted");
    expect(statusOf({ ended_at: null, exit_code: null, started_at: 0, last_activity_at: null }, LOST_AFTER_MS + 1)).toBe(
      "lost",
    );
  });

  it("keeps a long build running while it reports, and calls a quiet one lost", () => {
    const { runs, now } = store();
    runs.start({ id: "run_a", threadId: "thr_one", kind: "build", command: "a", logPath: null });
    now.value += LOST_AFTER_MS - 1000;
    runs.progress("thr_one", "run_a", "Compiling");
    now.value += LOST_AFTER_MS - 1000;
    expect(runs.get("thr_one", "run_a")?.status).toBe("running");
    now.value += 2000;
    expect(runs.get("thr_one", "run_a")?.status).toBe("lost");
    // A lost run can be dismissed; a reporting one cannot.
    runs.start({ id: "run_b", threadId: "thr_one", kind: "build", command: "b", logPath: null });
    expect(runs.dismissFinished("thr_one")).toBe(1);
    expect(runs.get("thr_one", "run_b")?.dismissed).toBe(false);
  });

  it("dismisses only finished runs", () => {
    const { runs } = store();
    runs.start({ id: "run_a", threadId: "thr_one", kind: "build", command: "a", logPath: null });
    runs.start({ id: "run_b", threadId: "thr_one", kind: "test", command: "b", logPath: null });
    runs.end("thr_one", "run_a", 1, null);
    expect(runs.dismissFinished("thr_one")).toBe(1);
    const byId = Object.fromEntries(runs.forThread("thr_one").map((run) => [run.id, run.dismissed]));
    expect(byId).toEqual({ run_a: true, run_b: false });
  });
});

describe("cleanup", () => {
  it("stops every live device of an archived thread, and nothing else", async () => {
    const { gateway, store } = createFakeGateway([
      stored({ id: "ios_a", labels: { "bb-thread": "thr_gone" } }),
      stored({ id: "sandbox_b", labels: { "bb-thread": "thr_gone" } }),
      stored({ id: "ios_c", labels: { "bb-thread": "thr_open" } }),
      stored({ id: "ios_d", labels: {} }),
    ]);
    expect(await stopThreadDevices(gateway, "thr_gone", quiet, "test")).toBe(2);
    expect(store.get("ios_a")?.state).toBe("terminated");
    expect(store.get("sandbox_b")?.state).toBe("terminated");
    expect(store.get("ios_c")?.state).toBe("ready");
    expect(store.get("ios_d")?.state).toBe("ready");
  });

  it("sweeps only this install's devices whose thread is archived or gone", async () => {
    const { gateway, store } = createFakeGateway([
      stored({ id: "ios_archived", labels: { "bb-thread": "thr_archived", "bb-install": "me" } }),
      stored({ id: "ios_deleted", labels: { "bb-thread": "thr_deleted", "bb-install": "me" } }),
      stored({ id: "ios_open", labels: { "bb-thread": "thr_open", "bb-install": "me" } }),
      stored({ id: "ios_unknown", labels: { "bb-thread": "thr_flaky", "bb-install": "me" } }),
      // Another bb's device for a thread this bb has never heard of.
      stored({ id: "ios_theirs", labels: { "bb-thread": "thr_deleted", "bb-install": "other" } }),
    ]);
    const states: Record<string, "open" | "archived" | "gone" | "unknown"> = {
      thr_archived: "archived",
      thr_deleted: "gone",
      thr_open: "open",
      thr_flaky: "unknown",
    };
    expect(await sweep(gateway, "me", async (id) => states[id] ?? "gone", quiet)).toBe(2);
    expect(store.get("ios_archived")?.state).toBe("terminated");
    expect(store.get("ios_deleted")?.state).toBe("terminated");
    expect(store.get("ios_open")?.state).toBe("ready");
    expect(store.get("ios_unknown")?.state).toBe("ready");
    expect(store.get("ios_theirs")?.state).toBe("ready");
  });
});

describe("service", () => {
  function service(seed = createFakeGateway()) {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const published: (string | null)[] = [];
    const svc = createService({
      resolveKey: async () => ({ key: "lim_test", source: "env" }),
      makeGateway: () => seed.gateway,
      runs: createRunStore(db),
      installId: "me",
      threadTitle: async () => "Fix the login screen",
      threadState: async () => "open",
      publish: (threadId) => published.push(threadId),
      log: quiet,
    });
    return { svc, published, ...seed };
  }

  it("starts a labeled simulator named after the thread", async () => {
    const { svc, store } = service();
    const device = await svc.startDevice("thr_one", "ipad");
    expect(device.threadId).toBe("thr_one");
    expect(store.get(device.id)?.labels).toMatchObject({ "bb-thread": "thr_one", "bb-install": "me", "bb-model": "ipad" });
    expect(device.displayName).toBe("bb: Fix the login screen");
  });

  it("joins a start already in flight instead of starting a second device", async () => {
    const { svc, calls } = service();
    const [a, b] = await Promise.all([svc.startDevice("thr_one", "iphone"), svc.startDevice("thr_one", "iphone")]);
    expect(a.id).toBe(b.id);
    expect(calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
  });

  it("streams and stops only the thread's own devices", async () => {
    const { svc } = service(
      createFakeGateway([
        stored({ id: "ios_mine", labels: { "bb-thread": "thr_one" } }),
        stored({ id: "ios_other", labels: { "bb-thread": "thr_two" } }),
      ]),
    );
    expect((await svc.stream("thr_one", "ios_mine")).token).toBe("stream-token");
    await expect(svc.stream("thr_one", "ios_other")).rejects.toThrow(/does not belong/);
    await expect(svc.stopDevice("thr_one", "ios_other")).rejects.toThrow(/does not belong/);
  });

  it("binds devices lim created implicitly, but never takes another thread's", async () => {
    const { svc, store } = service(
      createFakeGateway([
        stored({ id: "sandbox_new", labels: {} }),
        stored({ id: "ios_taken", labels: { "bb-thread": "thr_two" } }),
      ]),
    );
    const bound = await svc.bind("thr_one", ["sandbox_new", "ios_taken", "bogus_id"]);
    expect(bound.map((device) => device.id)).toEqual(["sandbox_new"]);
    expect(store.get("sandbox_new")?.labels["bb-thread"]).toBe("thr_one");
    expect(store.get("ios_taken")?.labels["bb-thread"]).toBe("thr_two");
  });

  it("stops by id only devices this install labeled", async () => {
    const { svc, store } = service(
      createFakeGateway([
        stored({ id: "ios_mine", labels: { "bb-thread": "thr_one", "bb-install": "me" } }),
        stored({ id: "ios_victim", labels: { "bb-thread": "thr_other", "bb-install": "someone-else" } }),
      ]),
    );
    await svc.stopLabeledDevice("ios_mine");
    expect(store.get("ios_mine")?.state).toBe("terminated");
    await expect(svc.stopLabeledDevice("ios_victim")).rejects.toThrow(/another bb/i);
    expect(store.get("ios_victim")?.state).toBe("ready");
  });

  it("refuses to stop a device no bb thread owns", async () => {
    const { svc } = service(createFakeGateway([stored({ id: "ios_person", labels: {} })]));
    await expect(svc.stopLabeledDevice("ios_person")).rejects.toThrow(/only stops devices labeled/);
  });


});
