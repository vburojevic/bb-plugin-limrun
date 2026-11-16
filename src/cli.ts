/**
 * `bb limrun`: status, the thread's devices and builds, and stopping one of
 * its devices.
 */
import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";

import { isThreadId } from "./labels";
import type { Device } from "./limrun";
import type { Run } from "./runs";
import type { LimrunService } from "./service";

export interface CliDeps {
  service: LimrunService;
  /** Whether a thread builds on Limrun. */
  isOn(threadId: string): boolean;
}

function minutesSince(iso: string, end: string | null): string {
  const start = Date.parse(iso);
  const stop = end === null ? Date.now() : Date.parse(end);
  if (!Number.isFinite(start) || !Number.isFinite(stop)) return "?";
  return `${Math.max(0, Math.round((stop - start) / 60_000))} min`;
}

export function deviceLine(device: Device): string {
  const what =
    device.kind === "xcode"
      ? "Xcode sandbox"
      : device.model === "ipad"
        ? "iPad"
        : device.model === "iphone"
          ? "iPhone"
          : "iOS simulator";
  return `${device.id}  ${what}  ${device.state}  ${minutesSince(device.createdAt, device.endedAt)}`;
}

function runLine(run: Run): string {
  return `${run.id}  ${run.kind}  ${run.status}${run.exitCode === null ? "" : ` (exit ${run.exitCode})`}  ${run.command}`;
}

function requireThread(threadId: string | undefined): string {
  if (!isThreadId(threadId)) {
    throw new PluginCliError("this command needs a bb thread", {
      code: "no_thread",
      hint: "Run it from an agent shell inside a bb thread (BB_THREAD_ID is set there).",
    });
  }
  return threadId;
}

async function asCliError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof PluginCliError) throw cause;
    throw new PluginCliError(cause instanceof Error ? cause.message : String(cause), { code: "limrun_failed" });
  }
}

export function limrunCli({ service, isOn }: CliDeps) {
  const json = { type: "boolean", description: "Print JSON" } as const;

  return defineCli({
    name: "limrun",
    summary: "Limrun cloud devices bound to bb threads: status, devices, builds and stop",
    commands: {
      status: cliCommand({
        summary: "Show the Limrun connection, whether this thread builds on Limrun, and its devices",
        options: { json },
        async run(input, ctx) {
          const connection = await service.connection();
          const on = isThreadId(ctx.threadId) ? isOn(ctx.threadId) : null;
          const devices =
            connection.connected && isThreadId(ctx.threadId)
              ? (await service.threadState(ctx.threadId)).devices
              : [];
          if (input.options.json) {
            return { exitCode: 0, stdout: JSON.stringify({ connection, buildOnLimrun: on, devices }) };
          }
          const lines = [
            connection.connected
              ? "Limrun: connected"
              : `Limrun: not connected. ${connection.error ?? ""}`.trim(),
          ];
          if (on !== null) {
            lines.push(
              on
                ? "Build on Limrun: on for this thread (lim is already set up here)"
                : "Build on Limrun: off for this thread (turn it on in the composer)",
            );
          }
          if (isThreadId(ctx.threadId)) {
            lines.push(devices.length === 0 ? "This thread has no Limrun devices." : "This thread's devices:");
            lines.push(...devices.map((device) => `  ${deviceLine(device)}`));
          }
          return { exitCode: 0, stdout: lines.join("\n") };
        },
      }),

      devices: cliCommand({
        summary: "List this thread's Limrun devices (live first, then recently ended)",
        options: { json },
        async run(input, ctx) {
          const threadId = requireThread(ctx.threadId);
          const { devices } = await asCliError(() => service.threadState(threadId));
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(devices) };
          return {
            exitCode: 0,
            stdout: devices.length === 0 ? "No Limrun devices for this thread." : devices.map(deviceLine).join("\n"),
          };
        },
      }),

      runs: cliCommand({
        summary: "List this thread's remote builds and tests on Limrun",
        options: { json },
        async run(input, ctx) {
          const threadId = requireThread(ctx.threadId);
          const runs = service.runs(threadId);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(runs) };
          return { exitCode: 0, stdout: runs.length === 0 ? "No remote builds yet." : runs.map(runLine).join("\n") };
        },
      }),

      stop: cliCommand({
        summary: "Stop one of this thread's Limrun devices (the Limrun page stops any of this bb's devices)",
        positionals: [{ name: "id", description: "Instance id, such as ios_… or sandbox_…", required: true }],
        options: { json },
        async run(input, ctx) {
          const id = input.positionals.id;
          // Thread scoped only: bb does not verify BB_THREAD_ID, so a no-thread
          // path would let any shell stop any thread's device.
          const threadId = requireThread(ctx.threadId);
          await asCliError(() => service.stopDevice(threadId, id));
          return {
            exitCode: 0,
            stdout: input.options.json ? JSON.stringify({ stopped: true, id }) : `Stopped ${id}.`,
          };
        },
      }),
    },
  });
}
