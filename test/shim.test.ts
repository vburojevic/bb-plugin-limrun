/**
 * Runs the generated shim for real, in front of a fake `lim` and a fake `bb`,
 * and checks what each one received.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { installShim, isRunLogPath, shimPaths, shimStatus, uninstallShim } from "../src/shim";

let root: string;
let paths: ReturnType<typeof shimPaths>;
let fakeBin: string;
let home: string;

function lines(file: string): string[][] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(paths.script, args, {
    env: {
      PATH: `${paths.binDir}:${fakeBin}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`,
      HOME: home,
      BB_CLI: join(fakeBin, "bb"),
      TMPDIR: join(root, "tmp"),
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { ...result, limCalls: lines(join(root, "lim-calls")), bbCalls: lines(join(root, "bb-calls")) };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "limrun-shim-"));
  paths = shimPaths(join(root, "data"));
  fakeBin = join(root, "fake-bin");
  home = join(root, "home");
  mkdirSync(fakeBin);
  mkdirSync(join(root, "tmp"));
  mkdirSync(join(home, ".lim"), { recursive: true });
  const node = process.execPath;
  // A fake lim: records argv, prints a little build output, optionally
  // records a new instance in last-instances.json, exits with FAKE_EXIT.
  writeFileSync(
    join(fakeBin, "lim"),
    `#!${node}
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(join(root, "lim-calls"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.FAKE_NEW_INSTANCE) {
  fs.writeFileSync(${JSON.stringify(join(home, ".lim", "last-instances.json"))}, JSON.stringify({ "/repo": { xcode: { id: process.env.FAKE_NEW_INSTANCE } } }));
}
if (process.argv[3] === "build") {
  process.stdout.write("Syncing 3 files\\n");
  process.stderr.write("\\u001b[31merror: Foo.swift:3: missing return\\u001b[0m\\n");
  setTimeout(() => process.stdout.write("Tip: Use --snapshot-key to build faster!\\n"), 50);
}
setTimeout(() => process.exit(Number(process.env.FAKE_EXIT || 0)), 100);
`,
  );
  writeFileSync(
    join(fakeBin, "bb"),
    `#!${node}
require("fs").appendFileSync(${JSON.stringify(join(root, "bb-calls"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
  );
  chmodSync(join(fakeBin, "lim"), 0o755);
  chmodSync(join(fakeBin, "bb"), 0o755);
  await installShim(paths, "bbi-test");
});

describe("lim shim", () => {
  it("installs, reports its status and uninstalls", async () => {
    const status = await shimStatus(paths);
    expect(status).toMatchObject({ installed: true, current: true });
    expect(status.pathLine).toBe(`export PATH="${paths.binDir}:$PATH"`);
    expect((await uninstallShim(paths)).installed).toBe(false);
  });

  it("hands over unchanged outside a bb thread", () => {
    const result = run(["ios", "create", "--model", "ipad"], { FAKE_EXIT: "3" });
    expect(result.status).toBe(3);
    expect(result.limCalls).toEqual([["ios", "create", "--model", "ipad"]]);
    expect(result.bbCalls).toEqual([]);
  });

  it("hands over unchanged when switched off", () => {
    const result = run(["ios", "create"], { BB_THREAD_ID: "thr_abc", BB_LIMRUN_SHIM: "off" });
    expect(result.limCalls).toEqual([["ios", "create"]]);
    expect(result.bbCalls).toEqual([]);
  });

  it("labels creates with the thread and this install", () => {
    const result = run(["ios", "create", "--reuse-if-exists"], { BB_THREAD_ID: "thr_abc" });
    expect(result.status).toBe(0);
    expect(result.limCalls).toEqual([
      ["ios", "create", "--reuse-if-exists", "--label", "bb-thread=thr_abc", "--label", "bb-install=bbi-test"],
    ]);
    const xcode = run(["xcode", "create"], { BB_THREAD_ID: "thr_abc" });
    expect(xcode.limCalls.at(-1)).toContain("bb-thread=thr_abc");
  });

  it("keeps a bb-thread label the caller already chose", () => {
    const result = run(["ios", "create", "--label", "bb-thread=thr_other"], { BB_THREAD_ID: "thr_abc" });
    expect(result.limCalls).toEqual([["ios", "create", "--label", "bb-thread=thr_other"]]);
  });

  it("leaves device commands alone", () => {
    const result = run(["ios", "tap", "100", "200"], { BB_THREAD_ID: "thr_abc" });
    expect(result.limCalls).toEqual([["ios", "tap", "100", "200"]]);
    expect(result.bbCalls).toEqual([]);
  });

  it("reports a failed remote build with its exit code, last line and log", () => {
    const result = run(["xcode", "build", ".", "--scheme", "App"], { BB_THREAD_ID: "thr_abc", FAKE_EXIT: "65" });
    expect(result.status).toBe(65);
    expect(result.stdout).toContain("Syncing 3 files");
    expect(result.stderr).toContain("missing return");
    const [start, end] = result.bbCalls;
    expect(start).toEqual(
      expect.arrayContaining(["limrun", "shim", "event", "--phase", "start", "--kind", "build", "--command=lim xcode build . --scheme App"]),
    );
    const runId = start![start!.indexOf("--run") + 1]!;
    expect(runId).toMatch(/^run_[a-z0-9]+$/);
    const logArg = start!.find((arg) => arg.startsWith("--log="))!;
    expect(readFileSync(logArg.slice("--log=".length), "utf8")).toContain("Syncing 3 files");
    expect(end).toEqual(expect.arrayContaining(["--phase", "end", "--run", runId, "--exit", "65"]));
    expect(end).toContain("--line=error: Foo.swift:3: missing return");
  });

  it("still reports the verdict when it cannot write a log (a sandboxed agent)", () => {
    writeFileSync(join(root, "not-a-dir"), "");
    const result = run(["xcode", "build", "."], { BB_THREAD_ID: "thr_abc", FAKE_EXIT: "0", TMPDIR: join(root, "not-a-dir") });
    expect(result.status).toBe(0);
    const [start, end] = result.bbCalls;
    expect(start?.some((arg) => arg.startsWith("--log="))).toBe(false);
    expect(end).toEqual(expect.arrayContaining(["--phase", "end", "--exit", "0"]));
  });

  it("writes the log where isRunLogPath accepts it", () => {
    const result = run(["xcode", "build", "."], { BB_THREAD_ID: "thr_abc" });
    const start = result.bbCalls[0]!;
    const runId = start[start.indexOf("--run") + 1]!;
    const log = start.find((arg) => arg.startsWith("--log="))!.slice("--log=".length);
    expect(isRunLogPath(log, runId)).toBe(true);
    expect(isRunLogPath(log, "run_other")).toBe(false);
    expect(isRunLogPath("/etc/passwd", runId)).toBe(false);
  });

  it("reports instances lim created implicitly so they can be labeled", () => {
    const result = run(["xcode", "build", "."], { BB_THREAD_ID: "thr_abc", FAKE_NEW_INSTANCE: "sandbox_euna_01abc" });
    const end = result.bbCalls.at(-1)!;
    expect(end).toEqual(expect.arrayContaining(["--phase", "end", "--instance", "sandbox_euna_01abc"]));
    const tap = run(["ios", "tap", "1", "2"], { BB_THREAD_ID: "thr_abc", FAKE_NEW_INSTANCE: "ios_euna_02def" });
    expect(tap.bbCalls.at(-1)).toEqual(["limrun", "shim", "event", "--phase", "bind", "--instance", "ios_euna_02def"]);
  });

  it("passes a crash signal's exit code through, like the real lim", () => {
    writeFileSync(
      join(fakeBin, "lim"),
      `#!${process.execPath}\nprocess.kill(process.pid, "SIGKILL");\n`,
    );
    chmodSync(join(fakeBin, "lim"), 0o755);
    expect(run(["ios", "list"]).status).toBe(137);
  });

  it("skips another bb's shim on PATH instead of looping", async () => {
    const other = shimPaths(join(root, "other-data"));
    await installShim(other, "bbi-other");
    const result = spawnSync(paths.script, ["ios", "list"], {
      env: {
        PATH: `${paths.binDir}:${other.binDir}:${fakeBin}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`,
        HOME: home,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(lines(join(root, "lim-calls"))).toEqual([["ios", "list"]]);
  });

  it("passes a SIGINT sent to the shim alone on to lim", async () => {
    writeFileSync(
      join(fakeBin, "lim"),
      `#!${process.execPath}\nsetTimeout(() => process.exit(0), 15000);\n`,
    );
    chmodSync(join(fakeBin, "lim"), 0o755);
    const { spawn } = await import("node:child_process");
    const child = spawn(paths.script, ["xcode", "build", "."], {
      env: {
        PATH: `${paths.binDir}:${fakeBin}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`,
        HOME: home,
      },
      stdio: "ignore",
      detached: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    process.kill(child.pid!, "SIGINT");
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000);
      child.on("exit", (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
    if (code === null) child.kill("SIGKILL");
    expect(code).toBe(130);
  });

  it("fails clearly when the real lim is missing", () => {
    const result = spawnSync(paths.script, ["ios", "list"], {
      env: { PATH: `${paths.binDir}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`, HOME: home },
      encoding: "utf8",
    });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("the real lim is not on PATH");
  });
});
