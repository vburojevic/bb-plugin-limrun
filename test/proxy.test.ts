/**
 * The bb-server proxy every Build on Limrun thread's lim talks to, against a
 * fake Limrun that records what reached it.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CAPS, agentEnv, agentInstructions, proxyServerPath } from "../src/agent";
import { MODE_MIGRATIONS, PENDING_FOR_MS, createModeStore, isNewThreadStart } from "../src/mode";
import { handleProxy, signThreadToken, verifyThreadToken, type ProxyDeps } from "../src/proxy";

const SECRET = "s".repeat(64);
const REAL_KEY = "lim_real_key_never_leaves";

interface Instance {
  id: string;
  labels: Record<string, string>;
  state: string;
}

/** A fake api.limrun.com: instances by id, every request logged. */
function fakeLimrun(seed: Instance[] = []) {
  const instances = new Map(seed.map((item) => [item.id, { ...item }]));
  const requests: { method: string; url: URL; auth: string | null; body: unknown }[] = [];
  let next = 1;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" || init?.body instanceof Uint8Array ? JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")) : null;
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ method: init?.method ?? "GET", url, auth, body });
    const reply = (status: number, value?: unknown) =>
      new Response(value === undefined ? null : JSON.stringify(value), {
        status,
        headers: value === undefined ? {} : { "content-type": "application/json" },
      });
    const collection = /^\/v1\/(ios|xcode)_instances$/.exec(url.pathname);
    const one = /^\/v1\/(ios|xcode)_instances\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (collection && init?.method === "POST") {
      const id = `${collection[1]}_fake_${next++}`;
      const labels = (body as { metadata?: { labels?: Record<string, string> } }).metadata?.labels ?? {};
      instances.set(id, { id, labels, state: "ready" });
      return reply(200, { metadata: { id, labels }, status: { state: "ready", token: "instance-token" } });
    }
    if (collection) {
      const selector = url.searchParams.get("labelSelector") ?? "";
      const states = url.searchParams.get("state")?.split(",");
      const match = [...instances.values()].filter(
        (item) =>
          item.id.startsWith(collection[1]!) &&
          selector.split(",").filter(Boolean).every((pair) => {
            const [key, value] = pair.split("=");
            return item.labels[key!] === value;
          }) &&
          (states === undefined || states.includes(item.state)),
      );
      return reply(200, match.map((item) => ({ metadata: { id: item.id, labels: item.labels }, status: { state: item.state } })));
    }
    if (one) {
      const item = instances.get(one[2]!);
      if (item === undefined) return reply(404, { message: "not found" });
      if (init?.method === "DELETE") {
        item.state = "terminated";
        return reply(204);
      }
      return reply(200, { metadata: { id: item.id, labels: item.labels }, status: { state: item.state } });
    }
    if (url.pathname.startsWith("/v1/assets")) return reply(200, { id: "asset_1" });
    return reply(500, { message: "unexpected" });
  }) as typeof fetch;
  return { instances, requests, fetchImpl };
}

function deps(limrun: ReturnType<typeof fakeLimrun>, overrides: Partial<ProxyDeps> = {}) {
  const changed: string[] = [];
  const base: ProxyDeps = {
    apiKey: async () => REAL_KEY,
    installId: "bbi-me",
    isOn: () => true,
    verifyToken: (token) => verifyThreadToken(SECRET, token),
    changed: (threadId) => changed.push(threadId),
    caps: CAPS,
    fetch: limrun.fetchImpl,
    upstream: "https://limrun.test",
    log: { info() {}, warn() {} },
  };
  return { deps: { ...base, ...overrides }, changed };
}

function call(threadId: string, method: string, limrunPath: string, options: { body?: unknown; query?: string; token?: string } = {}) {
  const query = options.query ? `&${options.query}` : "";
  const url = `http://bb.test/api/v1/plugins/limrun/http/lim?p=${limrunPath}${query}`;
  return new Request(url, {
    method,
    headers: {
      authorization: `Bearer ${options.token ?? signThreadToken(SECRET, threadId)}`,
      "content-type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe("thread tokens", () => {
  it("name exactly one thread and can't be forged", () => {
    const token = signThreadToken(SECRET, "thr_one");
    expect(verifyThreadToken(SECRET, token)).toBe("thr_one");
    expect(verifyThreadToken(SECRET, token.replace("thr_one", "thr_two"))).toBeNull();
    expect(verifyThreadToken("x".repeat(64), token)).toBeNull();
    expect(verifyThreadToken(SECRET, "lim_some_real_key")).toBeNull();
  });
});

describe("proxy", () => {
  it("adds the real key and the thread's labels to a create, and never passes the thread token on", async () => {
    const limrun = fakeLimrun();
    const { deps: d, changed } = deps(limrun);
    const response = await handleProxy(
      call("thr_one", "POST", "/v1/ios_instances", { body: { metadata: { labels: { issue: "7" } } }, query: "wait=true" }),
      d,
    );
    expect(response.status).toBe(200);
    const created = limrun.requests.find((request) => request.method === "POST")!;
    expect(created.url.pathname).toBe("/v1/ios_instances");
    expect(created.url.searchParams.get("wait")).toBe("true");
    expect(created.url.searchParams.has("p")).toBe(false);
    expect(created.auth).toBe(`Bearer ${REAL_KEY}`);
    expect(created.body).toMatchObject({ metadata: { labels: { issue: "7", "bb-thread": "thr_one", "bb-install": "bbi-me" } } });
    expect(limrun.requests.every((request) => request.auth === `Bearer ${REAL_KEY}`)).toBe(true);
    expect(changed).toEqual(["thr_one"]);
  });

  it("lists only the thread's own devices", async () => {
    const limrun = fakeLimrun([
      { id: "ios_mine", labels: { "bb-thread": "thr_one" }, state: "ready" },
      { id: "ios_theirs", labels: { "bb-thread": "thr_two" }, state: "ready" },
      { id: "ios_person", labels: {}, state: "ready" },
    ]);
    const response = await handleProxy(call("thr_one", "GET", "/v1/ios_instances"), deps(limrun).deps);
    const items = (await response.json()) as { metadata: { id: string } }[];
    expect(items.map((item) => item.metadata.id)).toEqual(["ios_mine"]);
  });

  it("reaches the thread's own device and its sub-paths, and refuses anyone else's", async () => {
    const limrun = fakeLimrun([
      { id: "xcode_mine", labels: { "bb-thread": "thr_one" }, state: "ready" },
      { id: "ios_theirs", labels: { "bb-thread": "thr_two" }, state: "ready" },
    ]);
    const { deps: d } = deps(limrun);
    expect((await handleProxy(call("thr_one", "GET", "/v1/xcode_instances/xcode_mine/cache"), d)).status).toBe(200);
    expect(limrun.requests.at(-1)!.url.pathname).toBe("/v1/xcode_instances/xcode_mine/cache");
    const stolen = await handleProxy(call("thr_one", "DELETE", "/v1/ios_instances/ios_theirs"), d);
    expect(stolen.status).toBe(404);
    expect(limrun.instances.get("ios_theirs")!.state).toBe("ready");
    const deleted = await handleProxy(call("thr_two", "DELETE", "/v1/ios_instances/ios_theirs"), d);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(limrun.instances.get("ios_theirs")!.state).toBe("terminated");
  });

  it("refuses dot segments, so a path can't climb out of the thread's own device", async () => {
    const limrun = fakeLimrun([
      { id: "ios_mine", labels: { "bb-thread": "thr_one" }, state: "ready" },
      { id: "ios_other", labels: { "bb-thread": "thr_two" }, state: "ready" },
    ]);
    const { deps: d } = deps(limrun);
    for (const [method, path] of [
      ["DELETE", "/v1/ios_instances/ios_mine/../ios_other"],
      ["GET", "/v1/assets/../../v1/api_keys"],
      ["POST", "/v1/assets/../ios_instances"],
      ["PATCH", "/v1/ios_instances/ios_mine/../ios_mine"],
      ["GET", "/v1/ios_instances/ios_mine/%2e%2e/ios_other"],
      ["GET", "/v1/ios_instances/ios_mine/./cache"],
    ]) {
      const response = await handleProxy(call("thr_one", method!, path!, { body: method === "GET" ? undefined : {} }), d);
      expect(response.status, `${method} ${path}`).toBe(400);
    }
    expect(limrun.instances.get("ios_other")!.state).toBe("ready");
    expect(limrun.requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("keeps the cap when creates race", async () => {
    const limrun = fakeLimrun();
    const slow = (async (input: string | URL, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return limrun.fetchImpl(input, init);
    }) as typeof fetch;
    const { deps: d } = deps(limrun, { fetch: slow });
    const statuses = await Promise.all(
      [1, 2, 3, 4].map(async () => (await handleProxy(call("thr_one", "POST", "/v1/ios_instances", { body: {} }), d)).status),
    );
    const live = [...limrun.instances.values()].filter((item) => item.state === "ready");
    expect(live.length).toBe(CAPS.ios);
    expect(statuses.filter((status) => status === 200).length).toBe(CAPS.ios);
  });

  it("refuses the rest of the org", async () => {
    const limrun = fakeLimrun();
    const { deps: d } = deps(limrun);
    for (const path of ["/v1/access_tokens", "/v1/analytics", "/v1/android_instances", "/v1/organizations/org_1/instance_webhook"]) {
      expect((await handleProxy(call("thr_one", "GET", path), d)).status).toBe(403);
    }
    expect(limrun.requests).toEqual([]);
    expect((await handleProxy(call("thr_one", "PUT", "/v1/assets", { body: { name: "App.zip" } }), d)).status).toBe(200);
  });

  it("refuses unknown tokens, the real key, and threads with the switch off", async () => {
    const limrun = fakeLimrun();
    expect((await handleProxy(call("thr_one", "GET", "/v1/ios_instances", { token: "lim_real" }), deps(limrun).deps)).status).toBe(401);
    const off = await handleProxy(call("thr_one", "GET", "/v1/ios_instances"), deps(limrun, { isOn: () => false }).deps);
    expect(off.status).toBe(403);
    expect(((await off.json()) as { message: string }).message).toMatch(/off for this bb thread/);
    const noKey = await handleProxy(call("thr_one", "GET", "/v1/ios_instances"), deps(limrun, { apiKey: async () => null }).deps);
    expect(noKey.status).toBe(503);
    expect(limrun.requests).toEqual([]);
  });

  it("stops a thread at its device limit, even through reuseIfExists", async () => {
    const limrun = fakeLimrun([
      { id: "ios_a", labels: { "bb-thread": "thr_one" }, state: "ready" },
      { id: "ios_b", labels: { "bb-thread": "thr_one" }, state: "ready" },
    ]);
    const { deps: d } = deps(limrun);
    expect((await handleProxy(call("thr_one", "POST", "/v1/ios_instances", { body: {} }), d)).status).toBe(409);
    const reused = await handleProxy(
      call("thr_one", "POST", "/v1/ios_instances", { body: {}, query: "reuseIfExists=true" }),
      d,
    );
    // The fake never reuses, so the extra device is created and stopped again.
    expect(reused.status).toBe(409);
    const extra = [...limrun.instances.values()].filter((item) => !["ios_a", "ios_b"].includes(item.id));
    expect(extra.every((item) => item.state === "terminated")).toBe(true);
  });

  it("keeps the thread's labels on a label change", async () => {
    const limrun = fakeLimrun([{ id: "ios_mine", labels: { "bb-thread": "thr_one" }, state: "ready" }]);
    await handleProxy(
      call("thr_one", "PATCH", "/v1/ios_instances/ios_mine", { body: { metadata: { labels: { other: "x" } } } }),
      deps(limrun).deps,
    );
    const patch = limrun.requests.find((request) => request.method === "PATCH")!;
    expect(patch.body).toMatchObject({ metadata: { labels: { other: "x", "bb-thread": "thr_one", "bb-install": "bbi-me" } } });
  });
});

describe("agent setup", () => {
  it("hands the agent a thread token and a server path, never the real key", () => {
    const token = signThreadToken(SECRET, "thr_one");
    const env = agentEnv("limrun", "thr_one", token);
    expect(env.map((entry) => entry.name)).toEqual(["LIM_API_ENDPOINT", "LIM_API_KEY", "LIM_WORKSPACE"]);
    expect(env[0]!.value).toEqual({ serverPath: proxyServerPath("limrun") });
    expect(proxyServerPath("limrun")).toBe("/api/v1/plugins/limrun/http/lim?p=");
    expect(env[1]!.value).toBe(token);
    expect(JSON.stringify(env)).not.toContain("lim_");
    expect(agentInstructions()).toMatch(/never run local `xcodebuild`/i);
  });
});

describe("new-thread flag", () => {
  const base = { attempt: "start-turn", initiator: "user", origin: { kind: "user" }, senderThreadId: null, threadCreatedAt: 0, now: 1_000 };
  it("goes only to a person's first message in a new thread", () => {
    expect(isNewThreadStart(base)).toBe(true);
    // A follow-up in a recent thread: bb sets no origin.
    expect(isNewThreadStart({ ...base, origin: null })).toBe(false);
    // A thread an agent started.
    expect(isNewThreadStart({ ...base, senderThreadId: "thr_parent" })).toBe(false);
    expect(isNewThreadStart({ ...base, initiator: "agent" })).toBe(false);
    expect(isNewThreadStart({ ...base, attempt: "join-turn" })).toBe(false);
    expect(isNewThreadStart({ ...base, now: PENDING_FOR_MS + 1 })).toBe(false);
  });
});

describe("modes", () => {
  it("switches threads and hands a new-thread flag to one thread only", () => {
    const db = new Database(":memory:");
    for (const statement of MODE_MIGRATIONS) db.exec(statement);
    const clock = { now: 1_000_000 };
    const modes = createModeStore(db, () => clock.now);
    expect(modes.isOn("thr_one")).toBe(false);
    modes.set("thr_one", true);
    expect(modes.isOn("thr_one")).toBe(true);
    expect(modes.onThreads()).toEqual(["thr_one"]);
    modes.setPending("proj_a", true);
    expect(modes.claimPending("proj_a")).toBe(true);
    expect(modes.claimPending("proj_a")).toBe(false);
    modes.setPending("proj_a", true);
    clock.now += PENDING_FOR_MS + 1;
    expect(modes.claimPending("proj_a")).toBe(false);
  });
});
