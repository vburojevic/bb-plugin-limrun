/**
 * Reading a build log back for the build card.
 *
 * The path comes from the shim, which runs in an agent's shell, so it is
 * untrusted: it must have the shim's own shape, its last component must not
 * be a symlink, and it must be a regular file this user owns with a single
 * link (a hard link is another name for some other file). Otherwise any
 * thread could point the card at another file the bb server can read.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { isRunLogPath } from "./shim";

const TAIL_BYTES = 64 * 1024;
const NOT_KEPT = { text: "No log was kept for this run.", truncated: false };

export async function readRunLog(path: string, runId: string): Promise<{ text: string; truncated: boolean }> {
  if (!isRunLogPath(path, runId)) return NOT_KEPT;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { text: "The log file is gone.", truncated: false } : NOT_KEPT;
  }
  try {
    const stat = await handle.stat();
    const ownedByUs = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isFile() || stat.nlink !== 1 || !ownedByUs) return NOT_KEPT;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    return { text: start > 0 ? text.slice(text.indexOf("\n") + 1) : text, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}
