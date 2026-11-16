/**
 * The plugin's only door to Limrun: list, start, label and stop instances,
 * hand out one instance's stream credentials, and read usage.
 *
 * Everything above this file talks in `Device`, a flat record with no tokens,
 * so nothing that reaches RPC, the CLI or a log can carry a credential by
 * accident. `stream()` is the one method that returns a token, and only the
 * stream-only token when Limrun provides one.
 */
import Limrun, { APIError } from "@limrun/api";

import { installOf, threadOf } from "./labels";

export type DeviceKind = "ios" | "xcode";

export interface Device {
  id: string;
  kind: DeviceKind;
  threadId: string | null;
  installId: string | null;
  displayName: string | null;
  /** `iphone` or `ipad` when bb started it; agents' devices may not say. */
  model: string | null;
  state: string;
  region: string | null;
  createdAt: string;
  endedAt: string | null;
  terminationReason: string | null;
  errorMessage: string | null;
}

export interface StreamCredentials {
  url: string;
  token: string;
  /** True when the token can only open the stream (Limrun's `streamToken`). */
  streamOnly: boolean;
}

export interface UsageTotals {
  billedMinutes: number;
  runtimeMinutes: number;
  cost: number;
  count: number;
}

export interface Usage {
  from: string;
  to: string;
  ios: UsageTotals;
  xcode: UsageTotals;
}

export interface ListOptions {
  labelSelector?: string;
  /** Only creating, assigned and ready instances. */
  live?: boolean;
  /** Upper bound on records read; Limrun pages its lists. */
  max?: number;
}

export interface CreateIosOptions {
  labels: Record<string, string>;
  displayName: string;
  model: "iphone" | "ipad";
}

export interface LimrunGateway {
  list(kind: DeviceKind, options?: ListOptions): Promise<Device[]>;
  get(kind: DeviceKind, id: string): Promise<Device | null>;
  createIos(options: CreateIosOptions): Promise<Device>;
  /** Deletes; an instance that is already gone counts as deleted. */
  remove(kind: DeviceKind, id: string): Promise<void>;
  /** Merges labels into a live instance. Returns the updated device, or null when gone. */
  addLabels(kind: DeviceKind, id: string, labels: Record<string, string>): Promise<Device | null>;
  stream(id: string): Promise<StreamCredentials | null>;
  usage(options: { from: string; to: string; labels?: string }): Promise<Usage>;
}

export const LIVE_STATES = ["creating", "assigned", "ready"] as const;
export const MODEL_LABEL = "bb-model";

/** A Limrun error worth showing to a person, without the raw response. */
export class LimrunFailure extends Error {
  constructor(
    message: string,
    readonly code: "key-rejected" | "not-found" | "rate-limited" | "unavailable" | "failed",
  ) {
    super(message);
    this.name = "LimrunFailure";
  }
}

export function describeFailure(cause: unknown): LimrunFailure {
  if (cause instanceof LimrunFailure) return cause;
  if (cause instanceof APIError) {
    const status = cause.status;
    if (status === 401 || status === 403) {
      return new LimrunFailure(
        "Limrun rejected the API key. Sign in again with `lim login`, or set LIM_API_KEY for the bb server.",
        "key-rejected",
      );
    }
    if (status === 404) return new LimrunFailure("That Limrun instance no longer exists.", "not-found");
    if (status === 429) return new LimrunFailure("Limrun is rate limiting requests. Try again in a minute.", "rate-limited");
    if (status !== undefined && status >= 500) {
      return new LimrunFailure(`Limrun is having trouble (HTTP ${status}). Try again shortly.`, "unavailable");
    }
    return new LimrunFailure(`Limrun refused the request (HTTP ${status ?? "?"}).`, "failed");
  }
  if (cause instanceof Error && /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(cause.message)) {
    return new LimrunFailure("Could not reach Limrun. Check the network connection.", "unavailable");
  }
  return new LimrunFailure("The Limrun request failed.", "failed");
}

interface RawInstance {
  metadata: {
    id: string;
    createdAt: string;
    displayName?: string;
    labels?: Record<string, string>;
    terminatedAt?: string;
  };
  spec?: { region?: string };
  status: {
    state: string;
    terminationReason?: string;
    errorMessage?: string;
  };
}

export function toDevice(kind: DeviceKind, raw: RawInstance): Device {
  const labels = raw.metadata.labels;
  return {
    id: raw.metadata.id,
    kind,
    threadId: threadOf(labels),
    installId: installOf(labels),
    displayName: raw.metadata.displayName ?? null,
    model: labels?.[MODEL_LABEL] ?? null,
    state: raw.status.state,
    region: raw.spec?.region ?? null,
    createdAt: raw.metadata.createdAt,
    endedAt: raw.metadata.terminatedAt ?? null,
    terminationReason: raw.status.terminationReason ?? null,
    errorMessage: raw.status.errorMessage ?? null,
  };
}

function emptyTotals(): UsageTotals {
  return { billedMinutes: 0, runtimeMinutes: 0, cost: 0, count: 0 };
}

/** Sums one platform's summary, which Limrun keys by region or model. */
export function sumTotals(group: Record<string, Partial<UsageTotals>> | undefined): UsageTotals {
  const totals = emptyTotals();
  for (const entry of Object.values(group ?? {})) {
    totals.billedMinutes += entry.billedMinutes ?? 0;
    totals.runtimeMinutes += entry.runtimeMinutes ?? 0;
    totals.cost += entry.cost ?? 0;
    totals.count += entry.count ?? 0;
  }
  return totals;
}

export function createLimrunGateway(apiKey: string): LimrunGateway {
  const client = new Limrun({ apiKey, maxRetries: 1, timeout: 120_000 });
  const resource = (kind: DeviceKind) => (kind === "ios" ? client.iosInstances : client.xcodeInstances);

  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      throw describeFailure(cause);
    }
  }

  async function getRaw(kind: DeviceKind, id: string) {
    try {
      return await resource(kind).get(id).withResponse();
    } catch (cause) {
      if (cause instanceof APIError && cause.status === 404) return null;
      throw describeFailure(cause);
    }
  }

  return {
    list: (kind, options = {}) =>
      guarded(async () => {
        const max = options.max ?? 500;
        const devices: Device[] = [];
        const query = {
          ...(options.labelSelector ? { labelSelector: options.labelSelector } : {}),
          ...(options.live ? { state: LIVE_STATES.join(",") } : {}),
          limit: 100,
        };
        for await (const raw of resource(kind).list(query)) {
          devices.push(toDevice(kind, raw as RawInstance));
          if (devices.length >= max) break;
        }
        return devices;
      }),

    async get(kind, id) {
      const found = await getRaw(kind, id);
      return found === null ? null : toDevice(kind, found.data as RawInstance);
    },

    createIos: (options) =>
      guarded(async () => {
        const raw = await client.iosInstances.create({
          wait: true,
          metadata: {
            displayName: options.displayName,
            labels: { ...options.labels, [MODEL_LABEL]: options.model },
          },
          spec: { model: options.model },
        });
        return toDevice("ios", raw as RawInstance);
      }),

    async remove(kind, id) {
      try {
        await resource(kind).delete(id);
      } catch (cause) {
        if (cause instanceof APIError && cause.status === 404) return;
        throw describeFailure(cause);
      }
    },

    async addLabels(kind, id, labels) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const found = await getRaw(kind, id);
        if (found === null) return null;
        const current = found.data as RawInstance;
        const existing = current.metadata.labels ?? {};
        const missing = Object.entries(labels).some(([key, value]) => existing[key] !== value);
        if (!missing) return toDevice(kind, current);
        if (!LIVE_STATES.includes(current.status.state as (typeof LIVE_STATES)[number])) {
          return toDevice(kind, current);
        }
        const etag = found.response.headers.get("etag");
        if (etag === null) throw new LimrunFailure("Limrun returned no ETag for a label change.", "failed");
        try {
          await resource(kind).update(id, {
            ifMatch: etag,
            metadata: { labels: { ...existing, ...labels } },
          });
          return toDevice(kind, {
            ...current,
            metadata: { ...current.metadata, labels: { ...existing, ...labels } },
          });
        } catch (cause) {
          if (cause instanceof APIError && cause.status === 412 && attempt === 0) continue;
          if (cause instanceof APIError && cause.status === 404) return null;
          throw describeFailure(cause);
        }
      }
      return null;
    },

    async stream(id) {
      const found = await getRaw("ios", id);
      if (found === null) return null;
      const status = found.data.status as {
        state: string;
        endpointWebSocketUrl?: string;
        streamToken?: string;
        token?: string;
      };
      if (status.state !== "ready" || !status.endpointWebSocketUrl) return null;
      const token = status.streamToken ?? status.token;
      if (!token) return null;
      return { url: status.endpointWebSocketUrl, token, streamOnly: status.streamToken !== undefined };
    },

    usage: (options) =>
      guarded(async () => {
        const response = await client.analytics.get({
          from: options.from,
          to: options.to,
          bucket: "day",
          ...(options.labels ? { labels: options.labels } : {}),
        });
        const summary = response.summary as unknown as {
          ios?: Record<string, Partial<UsageTotals>>;
          xcode?: Record<string, Partial<UsageTotals>>;
        };
        return {
          from: options.from,
          to: options.to,
          ios: sumTotals(summary.ios),
          xcode: sumTotals(summary.xcode),
        };
      }),
  };
}
