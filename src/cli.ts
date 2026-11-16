/**
 * `bb limrun`: status, the thread's devices, stopping one, the shim, and the
 * hidden `shim event` door the shim reports through.
 */
import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";

import { isThreadId } from "./labels";
import type { Device } from "./limrun";
import type { Run } from "./runs";
import type { LimrunService } from "./service";
import { installShim, isRunLogPath, shimStatus, uninstallShim, type ShimPaths } from "./shim";

export interface CliDeps {
  service: LimrunService;
  shimPaths: ShimPaths;
  installId: string;
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

export function limrunCli({ service, shimPaths, installId }: CliDeps) {
  const json = { type: "boolean", description: "Print JSON" } as const;

  return defineCli({
    name: "limrun",
    summary: "Limrun cloud devices bound to bb threads: status, devices, stop, and the lim shim",
    commands: {
      status: cliCommand({
        summary: "Show the Limrun connection, the shim, and this thread's devices",
        options: { json },
        async run(input, ctx) {
          const connection = await service.connection();
          const shim = await shimStatus(shimPaths);
          const devices =
            connection.connected && isThreadId(ctx.threadId)
              ? (await service.threadState(ctx.threadId)).devices
              : [];
          if (input.options.json) {
            return { exitCode: 0, stdout: JSON.stringify({ connection, shim, devices }) };
          }
          const lines = [
            connection.connected
              ? `Limrun: connected (key from ${connection.keySource === "env" ? "LIM_API_KEY" : "~/.lim/config.yaml"})`
              : `Limrun: not connected. ${connection.error ?? ""}`.trim(),
            shim.installed
              ? `Shim: installed at ${shim.script}${shim.current ? "" : " (outdated: run bb limrun shim install)"}`
              : "Shim: not installed (bb limrun shim install)",
          ];
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
        summary: "List this thread's remote builds and tests the shim reported",
        options: { json },
        async run(input, ctx) {
          const threadId = requireThread(ctx.threadId);
          const runs = service.runs(threadId);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(runs) };
          return { exitCode: 0, stdout: runs.length === 0 ? "No remote builds yet." : runs.map(runLine).join("\n") };
        },
      }),

      stop: cliCommand({
        summary: "Stop a Limrun device. In a thread, only that thread's devices",
        positionals: [{ name: "id", description: "Instance id, such as ios_… or sandbox_…", required: true }],
        options: { json },
        async run(input, ctx) {
          const id = input.positionals.id;
          await asCliError(async () => {
            if (isThreadId(ctx.threadId)) await service.stopDevice(ctx.threadId, id);
            else await service.stopLabeledDevice(id);
          });
          return {
            exitCode: 0,
            stdout: input.options.json ? JSON.stringify({ stopped: true, id }) : `Stopped ${id}.`,
          };
        },
      }),

      "shim install": cliCommand({
        summary: "Put the lim shim in place so devices and builds reach their thread",
        options: { json },
        async run(input) {
          const status = await installShim(shimPaths, installId);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(status) };
          return {
            exitCode: 0,
            stdout: [
              `Installed the lim shim at ${status.script}.`,
              "Add this line to your shell profile (~/.zshrc), ahead of anything else that puts lim on PATH:",
              `  ${status.pathLine}`,
              "Outside bb threads, or with BB_LIMRUN_SHIM=off, it runs the real lim unchanged.",
            ].join("\n"),
          };
        },
      }),

      "shim uninstall": cliCommand({
        summary: "Remove the lim shim",
        options: { json },
        async run(input) {
          const status = await uninstallShim(shimPaths);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(status) };
          return {
            exitCode: 0,
            stdout: `Removed the lim shim. Also remove ${status.binDir} from PATH in your shell profile.`,
          };
        },
      }),

      "shim status": cliCommand({
        summary: "Say whether the lim shim is installed",
        options: { json },
        async run(input) {
          const status = await shimStatus(shimPaths);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(status) };
          return {
            exitCode: 0,
            stdout: status.installed
              ? `Installed at ${status.script}. PATH line: ${status.pathLine}`
              : "Not installed. Run: bb limrun shim install",
          };
        },
      }),

      "shim event": cliCommand({
        summary: "Used by the lim shim to report devices and remote builds",
        hidden: true,
        options: {
          phase: { type: "enum", values: ["start", "progress", "end", "bind"], required: true, description: "Event" },
          run: { type: "string", description: "Run id (run_…)" },
          kind: { type: "enum", values: ["build", "test"], description: "Run kind" },
          command: { type: "string", description: "The lim command line" },
          log: { type: "string", description: "Log file path" },
          line: { type: "string", description: "Last log line" },
          exit: { type: "integer", min: -1, max: 255, description: "Exit code" },
          instance: { type: "string", repeatable: true, description: "Instance id lim created" },
        },
        async run(input, ctx) {
          const threadId = requireThread(ctx.threadId);
          const { phase, run, kind, command, log, line, exit, instance } = input.options;
          const runId = run !== undefined && /^run_[a-z0-9]{1,40}$/.test(run) ? run : null;
          if (phase !== "bind" && runId === null) {
            throw new PluginCliError("--run must be a run_… id", { code: "bad_run" });
          }
          // Only a path of the shim's own log shape is ever read back.
          const logPath = log !== undefined && runId !== null && isRunLogPath(log, runId) ? log : null;
          if (phase === "start") {
            service.runStarted(threadId, {
              id: runId!,
              kind: kind ?? "build",
              command: command ?? "lim xcode build",
              logPath,
            });
          } else if (phase === "progress") {
            if (line !== undefined) service.runProgress(threadId, runId!, line);
          } else if (phase === "end") {
            service.runEnded(threadId, runId!, exit ?? 1, line ?? null);
          }
          if (instance.length > 0) await asCliError(() => service.bind(threadId, instance));
          return { exitCode: 0, stdout: "ok" };
        },
      }),
    },
  });
}
