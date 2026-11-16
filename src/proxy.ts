/**
 * The Limrun proxy on the bb server.
 *
 * A thread that builds on Limrun gets, through bb's per-thread provider
 * environment, `LIM_API_ENDPOINT` pointing at this route and `LIM_API_KEY`
 * set to a token for that thread alone. Its `lim` (installed or through npx)
 * then calls Limrun through here, on whatever bb machine the thread runs:
 *
 * - the real API key is added here and never leaves the server, so it never
 *   shows in a thread's timeline (bb reports contributed env values as-is);
 * - every device the thread creates gets the `bb-thread` and `bb-install`
 *   labels, so it shows in the thread's Limrun tab and stops on archive;
 * - the thread sees and controls only its own devices, plus assets; the rest
 *   of the Limrun org is refused;
 * - at most `caps` devices of each kind run per thread.
 *
 * bb plugin routes match exact paths only, so the Limrun path rides in the
 * `p` query parameter: the endpoint is `…/http/lim?p=` and Limrun's SDK
 * appends `/v1/…` to it, keeping both in the query (checked against
 * @limrun/api's buildURL and lim 0.57.3).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { INSTALL_LABEL, THREAD_LABEL, isThreadId } from "./labels";
import { LIVE_STATES } from "./limrun";

export const PROXY_ROUTE = "/lim";
export const LIMRUN_API = "https://api.limrun.com";

export interface ProxyLog {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface ProxyDeps {
  /** The real Limrun API key, or null when none is configured. */
  apiKey(): Promise<string | null>;
  installId: string;
  isOn(threadId: string): boolean;
  verifyToken(token: string): string | null;
  /** A thread's devices changed (created, stopped, relabeled). */
  changed(threadId: string): void;
  caps: { ios: number; xcode: number };
  fetch?: typeof fetch;
  upstream?: string;
  log: ProxyLog;
}

/** `bblim.<thread id>.<mac>`: lets one thread, and only it, through the proxy. */
export function signThreadToken(secret: string, threadId: string): string {
  const mac = createHmac("sha256", secret).update(`limrun-thread:${threadId}`).digest("base64url").slice(0, 32);
  return `bblim.${threadId}.${mac}`;
}

export function verifyThreadToken(secret: string, token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "bblim" || !isThreadId(parts[1])) return null;
  const expected = Buffer.from(signThreadToken(secret, parts[1]!));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given) ? parts[1]! : null;
}

function json(status: number, message: string): Response {
  return new Response(JSON.stringify({ message, code: "bb_limrun_proxy" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Kind = "ios" | "xcode";

const COLLECTION = /^\/v1\/(ios|xcode)_instances$/;
const INSTANCE = /^\/v1\/(ios|xcode)_instances\/([A-Za-z0-9_]{1,120})(\/[A-Za-z0-9_\-/.]*)?$/;
const ASSETS = /^\/v1\/assets(\/[A-Za-z0-9_\-/.]*)?$/;

/**
 * A Limrun path the proxy will look at: `/v1/…`, no `.` or `..` segment, no
 * encoded dot, slash or backslash, and unchanged by URL normalization. Without
 * this, `/v1/ios_instances/<mine>/../<theirs>` passes the ownership check on
 * `<mine>` and fetch resolves it to someone else's device.
 */
export function isPlainPath(path: string): boolean {
  if (!path.startsWith("/v1/") || /%2e|%2f|%5c|\\/i.test(path)) return false;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  try {
    return new URL(path, "https://limrun.invalid").pathname === path;
  } catch {
    return false;
  }
}

/** One create at a time per thread and kind, so racing creates can't pass the cap together. */
const createQueues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = createQueues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => {});
  createQueues.set(key, settled);
  void settled.then(() => {
    if (createQueues.get(key) === settled) createQueues.delete(key);
  });
  return next;
}

export async function handleProxy(request: Request, deps: ProxyDeps): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const upstream = deps.upstream ?? LIMRUN_API;
  const url = new URL(request.url);
  const path = url.searchParams.get("p") ?? "";
  url.searchParams.delete("p");
  if (!isPlainPath(path)) return json(400, "bb's Limrun proxy only takes plain /v1/ paths.");

  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const threadId = deps.verifyToken(bearer);
  if (threadId === null) return json(401, "This lim is not set up by a bb thread that builds on Limrun.");
  if (!deps.isOn(threadId)) {
    return json(403, "Build on Limrun is off for this bb thread. Turn it on in the thread's composer.");
  }
  const key = await deps.apiKey();
  if (key === null) return json(503, "The bb Limrun plugin has no Limrun API key. Paste one on bb's Limrun page.");

  const method = request.method.toUpperCase();
  const raw = method === "GET" || method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
  const body = raw !== null && raw.length > 0 ? raw : null;

  const send = async (target: string, query: URLSearchParams, init: { method: string; body: Uint8Array | null }) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      accept: request.headers.get("accept") ?? "application/json",
    };
    const type = request.headers.get("content-type");
    if (type !== null && init.body !== null) headers["content-type"] = type;
    const ifMatch = request.headers.get("if-match");
    if (ifMatch !== null) headers["if-match"] = ifMatch;
    const search = query.toString();
    return doFetch(`${upstream}${target}${search ? `?${search}` : ""}`, {
      method: init.method,
      headers,
      body: init.body === null ? undefined : (init.body as unknown as BodyInit),
    });
  };

  const relay = async (response: Response): Promise<Response> => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    const type = response.headers.get("content-type");
    if (bytes.length > 0 && type !== null) headers["content-type"] = type;
    const etag = response.headers.get("etag");
    if (etag !== null) headers.etag = etag;
    return new Response(bytes.length > 0 ? bytes : null, { status: response.status, headers });
  };

  const ownedBy = async (kind: Kind, id: string): Promise<"mine" | "other" | "gone"> => {
    const response = await send(`/v1/${kind}_instances/${id}`, new URLSearchParams(), { method: "GET", body: null });
    if (response.status === 404) return "gone";
    if (!response.ok) return "other";
    const record = (await response.json()) as { metadata?: { labels?: Record<string, string> } };
    return record.metadata?.labels?.[THREAD_LABEL] === threadId ? "mine" : "other";
  };

  const liveIds = async (kind: Kind): Promise<Set<string>> => {
    const query = new URLSearchParams({ labelSelector: `${THREAD_LABEL}=${threadId}`, state: LIVE_STATES.join(",") });
    const response = await send(`/v1/${kind}_instances`, query, { method: "GET", body: null });
    if (!response.ok) return new Set();
    const items = (await response.json()) as { metadata: { id: string } }[];
    return new Set(items.map((item) => item.metadata.id));
  };

  const collection = COLLECTION.exec(path);
  if (collection !== null) {
    const kind = collection[1] as Kind;
    if (method === "GET") {
      const selector = url.searchParams.get("labelSelector");
      url.searchParams.set(
        "labelSelector",
        [selector, `${THREAD_LABEL}=${threadId}`].filter((part) => part !== null && part !== "").join(","),
      );
      return relay(await send(path, url.searchParams, { method, body }));
    }
    if (method === "POST") return oneAtATime(`${threadId}:${kind}`, async () => {
      let spec: { metadata?: { labels?: Record<string, string> } } & Record<string, unknown>;
      try {
        spec = body !== null && body.length > 0 ? JSON.parse(Buffer.from(body).toString("utf8")) : {};
      } catch {
        return json(400, "The create request was not JSON.");
      }
      spec.metadata = {
        ...spec.metadata,
        labels: { ...spec.metadata?.labels, [THREAD_LABEL]: threadId, [INSTALL_LABEL]: deps.installId },
      };
      const labeled = new TextEncoder().encode(JSON.stringify(spec));
      const before = await liveIds(kind);
      const cap = deps.caps[kind];
      const reuse = url.searchParams.get("reuseIfExists") === "true";
      const noun = kind === "ios" ? "simulators" : "Xcode sandboxes";
      if (before.size >= cap && !reuse) {
        return json(409, `This bb thread already runs ${before.size} ${noun}, its limit. Stop one or reuse one with --id.`);
      }
      const response = await send(path, url.searchParams, { method, body: labeled });
      if (!response.ok) return relay(response);
      const created = (await response.clone().json()) as { metadata?: { id?: string } };
      const id = created.metadata?.id;
      if (before.size >= cap && id !== undefined && !before.has(id)) {
        // reuseIfExists found no match and made one more than the cap allows.
        await send(`/v1/${kind}_instances/${id}`, new URLSearchParams(), { method: "DELETE", body: null });
        return json(409, `This bb thread already runs ${before.size} ${noun}, its limit. Stop one or reuse one with --id.`);
      }
      deps.log.info("proxy created device", { threadId, kind, id });
      deps.changed(threadId);
      return relay(response);
    });
    return json(405, "bb's Limrun proxy does not allow that.");
  }

  const instance = INSTANCE.exec(path);
  if (instance !== null) {
    const kind = instance[1] as Kind;
    const owner = await ownedBy(kind, instance[2]!);
    if (owner === "gone") return json(404, "That Limrun instance no longer exists.");
    if (owner === "other") return json(404, "That Limrun device does not belong to this bb thread.");
    let forwarded = body;
    if (method === "PATCH" && instance[3] === undefined && body !== null && body.length > 0) {
      // A label change may not drop the thread's own labels.
      try {
        const patch = JSON.parse(Buffer.from(body).toString("utf8")) as {
          metadata?: { labels?: Record<string, string> };
        };
        if (patch.metadata?.labels !== undefined) {
          patch.metadata.labels = {
            ...patch.metadata.labels,
            [THREAD_LABEL]: threadId,
            [INSTALL_LABEL]: deps.installId,
          };
          forwarded = new TextEncoder().encode(JSON.stringify(patch));
        }
      } catch {
        return json(400, "The update request was not JSON.");
      }
    }
    const response = await send(path, url.searchParams, { method, body: forwarded });
    if (method !== "GET" && method !== "HEAD") deps.changed(threadId);
    return relay(response);
  }

  if (ASSETS.test(path)) return relay(await send(path, url.searchParams, { method, body }));

  return json(403, "bb's Limrun proxy only reaches this thread's simulators and Xcode sandboxes, and assets.");
}
