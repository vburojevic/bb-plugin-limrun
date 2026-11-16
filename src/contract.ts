/**
 * The frontend data plane. Schemas run at the wire boundary on the server;
 * app code imports only the contract's type.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadId = z.string().regex(/^thr_[A-Za-z0-9_-]{1,64}$/);
const instanceId = z.string().regex(/^[a-z]+_[A-Za-z0-9_]{1,120}$/);

export const deviceSchema = z.object({
  id: z.string(),
  kind: z.enum(["ios", "xcode"]),
  threadId: z.string().nullable(),
  installId: z.string().nullable(),
  displayName: z.string().nullable(),
  model: z.string().nullable(),
  state: z.string(),
  region: z.string().nullable(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  terminationReason: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

export const runSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  kind: z.enum(["build", "test"]),
  command: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  exitCode: z.number().nullable(),
  status: z.enum(["running", "passed", "failed", "interrupted", "lost"]),
  lastLine: z.string().nullable(),
  lastActivityAt: z.number(),
  dismissed: z.boolean(),
});

const totalsSchema = z.object({
  billedMinutes: z.number(),
  runtimeMinutes: z.number(),
  cost: z.number(),
  count: z.number(),
});

const usageSchema = z.object({ from: z.string(), to: z.string(), ios: totalsSchema, xcode: totalsSchema });

export const rpcContract = defineRpcContract({
  overview: {
    input: z.null(),
    output: z.object({
      connected: z.boolean(),
      keySource: z.enum(["env", "lim-config"]).nullable(),
      error: z.string().nullable(),
      shim: z.object({ installed: z.boolean(), current: z.boolean(), pathLine: z.string() }),
    }),
  },
  thread_state: {
    input: z.object({ threadId }).strict(),
    output: z.object({
      devices: z.array(deviceSchema),
      runs: z.array(runSchema),
      starting: z.array(z.enum(["iphone", "ipad"])),
      error: z.string().nullable(),
    }),
  },
  thread_runs: {
    input: z.object({ threadId }).strict(),
    output: z.object({ runs: z.array(runSchema) }),
  },
  thread_usage: {
    input: z.object({ threadId }).strict(),
    output: z.object({ deviceMinutes: z.number(), billed: usageSchema.nullable() }),
  },
  start_device: {
    input: z.object({ threadId, model: z.enum(["iphone", "ipad"]) }).strict(),
    output: deviceSchema,
  },
  stop_device: {
    input: z.object({ threadId, id: instanceId }).strict(),
    output: z.object({ stopped: z.boolean() }),
  },
  stop_labeled_device: {
    input: z.object({ id: instanceId }).strict(),
    output: z.object({ stopped: z.boolean() }),
  },
  stream: {
    input: z.object({ threadId, id: instanceId }).strict(),
    output: z.object({ url: z.string(), token: z.string(), streamOnly: z.boolean() }),
  },
  dismiss_runs: {
    input: z.object({ threadId }).strict(),
    output: z.object({ dismissed: z.number() }),
  },
  run_log: {
    input: z.object({ threadId, runId: z.string().regex(/^run_[a-z0-9]{1,40}$/) }).strict(),
    output: z.object({ text: z.string(), truncated: z.boolean() }),
  },
  org: {
    input: z.null(),
    output: z.object({
      today: usageSchema.nullable(),
      month: usageSchema.nullable(),
      live: z.array(deviceSchema),
      error: z.string().nullable(),
    }),
  },
});

export type RpcContract = typeof rpcContract;
export type DeviceDto = z.infer<typeof deviceSchema>;
export type RunDto = z.infer<typeof runSchema>;
export type UsageDto = z.infer<typeof usageSchema>;

/** Realtime channel: payload `{ threadId: string | null }`. */
export const CHANGED_CHANNEL = "limrun-changed";
