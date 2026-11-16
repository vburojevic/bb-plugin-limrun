// Builds the committed tree the way bb's git install does: production
// dependencies only, no lifecycle scripts, then `bb plugin build`. A frontend
// or server import that only resolves with dev dependencies fails here.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "limrun-install-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
try {
  execFileSync("sh", ["-c", `git archive HEAD | tar -x -C "${dir}"`], { stdio: "inherit" });
  run("npm", ["install", "--omit=dev", "--omit=optional", "--ignore-scripts", "--silent"], dir);
  run("bb", ["plugin", "build"], dir);
  console.log("check:install ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
