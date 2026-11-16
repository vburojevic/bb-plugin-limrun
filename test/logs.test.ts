import { linkSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { readRunLog } from "../src/logs";

describe("run logs", () => {
  const root = mkdtempSync(join(tmpdir(), "limrun-logs-"));
  const dir = join(root, "bb-limrun");
  mkdirSync(dir);

  it("reads the tail of a regular log file, without terminal colors", async () => {
    writeFileSync(join(dir, "run_ok.log"), "one\n\u001b[31mtwo\u001b[0m\n");
    expect(await readRunLog(join(dir, "run_ok.log"), "run_ok")).toEqual({ text: "one\ntwo\n", truncated: false });
  });

  it("refuses a symlink, so a log path can't point at another file", async () => {
    writeFileSync(join(root, "secret.txt"), "api-key: lim_secret\n");
    symlinkSync(join(root, "secret.txt"), join(dir, "run_link.log"));
    const result = await readRunLog(join(dir, "run_link.log"), "run_link");
    expect(result.text).not.toContain("lim_secret");
  });

  it("refuses a hard link to another file", async () => {
    writeFileSync(join(root, "config.yaml"), "api-key: lim_hardlinked\n");
    linkSync(join(root, "config.yaml"), join(dir, "run_hard.log"));
    expect((await readRunLog(join(dir, "run_hard.log"), "run_hard")).text).not.toContain("lim_hardlinked");
  });

  it("refuses something that is not a regular file", async () => {
    execFileSync("mkfifo", [join(dir, "run_fifo.log")]);
    const result = await readRunLog(join(dir, "run_fifo.log"), "run_fifo");
    expect(result.text).toBe("No log was kept for this run.");
  });

  it("refuses paths of the wrong shape", async () => {
    writeFileSync(join(root, "run_x.log"), "outside\n");
    expect((await readRunLog(join(root, "run_x.log"), "run_x")).text).toBe("No log was kept for this run.");
  });
});
