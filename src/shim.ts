/**
 * The `lim` shim.
 *
 * Agents keep typing `lim` (Limrun's own skills teach it), so the plugin
 * learns about their devices and remote builds by standing in front of the
 * real CLI on PATH. It is opt-in: `bb limrun shim install` writes it and
 * prints the PATH line to add. In a shell outside a bb thread, or with
 * `BB_LIMRUN_SHIM=off`, it hands straight over to the real `lim`.
 *
 * Inside a thread it does three things and nothing else:
 *
 * 1. appends `--label bb-thread=<thread>` and `--label bb-install=<id>` to
 *    `lim ios create` and `lim xcode create` (never rewriting an existing
 *    bb-thread label);
 * 2. reports each `lim xcode build` and `lim xcode test` to the thread:
 *    start, a last log line at most every two seconds, and the exit code,
 *    teeing the output to a log file the build card reads;
 * 3. after any command, reports instance ids that appeared in lim's
 *    `~/.lim/last-instances.json`, so devices lim created implicitly (a build
 *    with no sandbox yet, a `tap` with no simulator) get the thread label too.
 *
 * Every report is best effort with a timeout: the shim must never be the
 * reason a lim command fails or hangs. It is plain Node (CommonJS, no
 * dependencies), since lim itself requires Node 20.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface ShimPaths {
  /** Directory to put first on PATH. */
  binDir: string;
  /** The shim executable. */
  script: string;
}

export function shimPaths(dataDir: string): ShimPaths {
  return {
    binDir: join(dataDir, "shim"),
    script: join(dataDir, "shim", "lim"),
  };
}

/**
 * Build output is teed into `<agent's temp dir>/bb-limrun/<run id>.log`: an
 * agent's sandbox can write its own temp dir but not the plugin's data dir
 * (found on a real sandboxed Claude Code thread). The server only ever reads
 * a path of exactly this shape.
 */
export const RUN_LOG_DIR = "bb-limrun";

export function isRunLogPath(path: string, runId: string): boolean {
  return isAbsolute(path) && basename(path) === `${runId}.log` && basename(dirname(path)) === RUN_LOG_DIR && !path.includes("..");
}

export const SHIM_MARKER = "bb-plugin-limrun shim";
export const SHIM_VERSION = 3;

/** The shim's source. `installId` and the paths are baked in as JSON literals. */
export function shimScript(options: { installId: string; binDir: string }): string {
  const constants = JSON.stringify({
    installId: options.installId,
    binDir: options.binDir,
    logDir: RUN_LOG_DIR,
    version: SHIM_VERSION,
  });
  return `#!/usr/bin/env node
// ${SHIM_MARKER} v${SHIM_VERSION}. Remove with: bb limrun shim uninstall
// Tags lim devices with the bb thread that made them and reports remote
// builds to that thread. Hands over to the real lim unchanged outside bb.
"use strict";
const C = ${constants};
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const args = process.argv.slice(2);
// Nothing in here may break lim: an unexpected error is reported once and
// the shim keeps waiting for the real command.
process.on("uncaughtException", (error) => {
  try { process.stderr.write("bb limrun shim: " + (error && error.message ? error.message : String(error)) + "\\n"); } catch (_) {}
});
const thread = process.env.BB_THREAD_ID || "";
const active = /^thr_[A-Za-z0-9_-]{1,64}$/.test(thread) && process.env.BB_LIMRUN_SHIM !== "off";

function realLim() {
  let self = "";
  try { self = fs.realpathSync(C.binDir); } catch (_) { self = C.binDir; }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    let resolved = dir;
    try { resolved = fs.realpathSync(dir); } catch (_) { continue; }
    if (resolved === self) continue;
    const candidate = path.join(dir, "lim");
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) {}
  }
  return null;
}

const real = realLim();
if (real === null) {
  process.stderr.write("bb limrun shim: the real lim is not on PATH. Install it with: npm install --global lim\\n");
  process.exit(127);
}

function lastInstances() {
  try { return fs.readFileSync(path.join(os.homedir(), ".lim", "last-instances.json"), "utf8"); } catch (_) { return ""; }
}
function instanceIds(text) {
  const found = new Set();
  const pattern = /\\b(?:ios|sandbox|xcode)_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\\b/g;
  let match;
  while ((match = pattern.exec(text)) !== null) found.add(match[0]);
  return found;
}

function report(extra, wait) {
  if (!active) return;
  const bb = process.env.BB_CLI || "bb";
  const argv = ["limrun", "shim", "event", ...extra];
  try {
    if (wait) {
      spawnSync(bb, argv, { stdio: "ignore", timeout: 5000 });
    } else {
      const child = spawn(bb, argv, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    }
  } catch (_) {}
}

const verb = args[0] || "";
const sub = args[1] || "";
let finalArgs = args;
if (active && (verb === "ios" || verb === "xcode") && sub === "create") {
  const hasThread = args.some((a, i) =>
    a.startsWith("--label=bb-thread=") || (a === "--label" && (args[i + 1] || "").startsWith("bb-thread=")));
  if (!hasThread) {
    finalArgs = [...args, "--label", "bb-thread=" + thread, "--label", "bb-install=" + C.installId];
  }
}

const before = active ? lastInstances() : "";
const isRun = active && verb === "xcode" && (sub === "build" || sub === "test");
const runId = isRun ? "run_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) : "";
let logStream = null;
let lastLine = "";
let reportedLine = "";
let ticker = null;

if (isRun) {
  let logPath = "";
  try {
    const dir = path.join(os.tmpdir(), C.logDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    logPath = path.join(dir, runId + ".log");
    fs.writeFileSync(logPath, "", { mode: 0o600 });
    logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.on("error", () => { logStream = null; });
  } catch (_) { logStream = null; logPath = ""; }
  const command = ["lim", ...args].join(" ").slice(0, 600);
  report(["--phase", "start", "--run", runId, "--kind", sub, "--command=" + command, ...(logPath ? ["--log=" + logPath] : [])], true);
  ticker = setInterval(() => {
    if (lastLine && lastLine !== reportedLine) {
      reportedLine = lastLine;
      report(["--phase", "progress", "--run", runId, "--line=" + lastLine.slice(0, 400)], false);
    }
  }, 2000);
  ticker.unref();
}

function track(chunk) {
  if (logStream) logStream.write(chunk);
  const lines = chunk.toString("utf8").split(/\\r?\\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\\u001b\\[[0-9;]*[A-Za-z]/g, "").trim();
    // lim ends with advice ("Tip: …"); the line before it is the result.
    if (line && !/^(Tip|Hint):/i.test(line)) { lastLine = line; break; }
  }
}

const child = spawn(real, finalArgs, { stdio: isRun ? ["inherit", "pipe", "pipe"] : "inherit" });
if (isRun) {
  child.stdout.on("data", (c) => { process.stdout.write(c); track(c); });
  child.stderr.on("data", (c) => { process.stderr.write(c); track(c); });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { try { child.kill(signal); } catch (_) {} });
}
child.on("error", (error) => {
  process.stderr.write("bb limrun shim: could not run " + real + ": " + error.message + "\\n");
  process.exit(127);
});
child.on("close", (code, signal) => {
  const exitCode = code === null ? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1) : code;
  if (ticker) clearInterval(ticker);
  if (logStream) logStream.end();
  let fresh = [];
  if (active) {
    const seen = instanceIds(before);
    fresh = [...instanceIds(lastInstances())].filter((id) => !seen.has(id));
  }
  const bindArgs = fresh.flatMap((id) => ["--instance", id]);
  if (isRun) {
    report(["--phase", "end", "--run", runId, "--exit", String(exitCode), ...(lastLine ? ["--line=" + lastLine.slice(0, 400)] : []), ...bindArgs], true);
  } else if (fresh.length > 0) {
    report(["--phase", "bind", ...bindArgs], true);
  }
  process.exit(exitCode);
});
`;
}

export interface ShimStatus {
  installed: boolean;
  current: boolean;
  binDir: string;
  script: string;
  pathLine: string;
}

export function pathLine(binDir: string): string {
  return `export PATH="${binDir}:$PATH"`;
}

export async function shimStatus(paths: ShimPaths): Promise<ShimStatus> {
  let text: string | null = null;
  try {
    text = await readFile(paths.script, "utf8");
  } catch {
    text = null;
  }
  return {
    installed: text !== null && text.includes(SHIM_MARKER),
    current: text !== null && text.includes(`${SHIM_MARKER} v${SHIM_VERSION}.`),
    binDir: paths.binDir,
    script: paths.script,
    pathLine: pathLine(paths.binDir),
  };
}

export async function installShim(paths: ShimPaths, installId: string): Promise<ShimStatus> {
  await mkdir(paths.binDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.script, shimScript({ installId, binDir: paths.binDir }), {
    mode: 0o755,
  });
  await chmod(paths.script, 0o755);
  return shimStatus(paths);
}

export async function uninstallShim(paths: ShimPaths): Promise<ShimStatus> {
  await rm(paths.script, { force: true });
  return shimStatus(paths);
}
