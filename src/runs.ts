/**
 * Remote build and test runs, as the shim reports them.
 *
 * Limrun cannot push build events to a bb on a laptop (its webhooks need a
 * public HTTPS host), so the shim in front of `lim` reports each
 * `lim xcode build` and `lim xcode test` itself: start, a throttled last log
 * line, and the exit code. This table is the plugin's whole memory of them.
 */
import type Database from "better-sqlite3";

export type RunKind = "build" | "test";
export type RunStatus = "running" | "passed" | "failed" | "interrupted" | "lost";

export interface Run {
  id: string;
  threadId: string;
  kind: RunKind;
  command: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  status: RunStatus;
  lastLine: string | null;
  /** The last start, progress or end report; a running build goes quiet only when its shim died. */
  lastActivityAt: number;
  dismissed: boolean;
}

interface Row {
  id: string;
  thread_id: string;
  kind: string;
  command: string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  last_line: string | null;
  log_path: string | null;
  dismissed: number;
  last_activity_at: number | null;
}

/**
 * A running build reports its last log line every two seconds while output
 * flows. Twenty quiet minutes means its shim was killed or crashed (found on a
 * sandboxed agent thread), so the card stops claiming it is building.
 */
export const LOST_AFTER_MS = 20 * 60 * 1000;

export const MIGRATIONS = [
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     command TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     ended_at INTEGER,
     exit_code INTEGER,
     last_line TEXT,
     log_path TEXT,
     dismissed INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX runs_thread ON runs (thread_id, started_at DESC)`,
  `ALTER TABLE runs ADD COLUMN last_activity_at INTEGER`,
  // v0.2: builds are followed from the server; the sandbox they ran on.
  `ALTER TABLE runs ADD COLUMN sandbox_id TEXT`,
];

export function lastActivity(row: Pick<Row, "started_at" | "last_activity_at">): number {
  return Math.max(row.started_at, row.last_activity_at ?? 0);
}

export function statusOf(
  row: Pick<Row, "ended_at" | "exit_code" | "started_at" | "last_activity_at">,
  now: number,
): RunStatus {
  if (row.ended_at === null) return now - lastActivity(row) > LOST_AFTER_MS ? "lost" : "running";
  if (row.exit_code === 0) return "passed";
  // 130 and 143: the person or the agent stopped it (SIGINT, SIGTERM).
  if (row.exit_code === 130 || row.exit_code === 143) return "interrupted";
  return "failed";
}

const MAX_LINE = 400;
const MAX_COMMAND = 600;

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function createRunStore(db: Database.Database, now: () => number = Date.now) {
  const toRun = (row: Row): Run => ({
    id: row.id,
    threadId: row.thread_id,
    kind: row.kind === "test" ? "test" : "build",
    command: row.command,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    status: statusOf(row, now()),
    lastLine: row.last_line,
    lastActivityAt: lastActivity(row),
    dismissed: row.dismissed === 1,
  });

  return {
    start(input: { id: string; threadId: string; kind: RunKind; command: string; logPath: string | null }): Run {
      db.prepare(
        `INSERT INTO runs (id, thread_id, kind, command, started_at, log_path)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(input.id, input.threadId, input.kind, clip(input.command, MAX_COMMAND), now(), input.logPath);
      return this.get(input.threadId, input.id)!;
    },

    progress(threadId: string, id: string, line: string): Run | null {
      db.prepare(
        `UPDATE runs SET last_line = ?, last_activity_at = ? WHERE id = ? AND thread_id = ? AND ended_at IS NULL`,
      ).run(clip(line, MAX_LINE), now(), id, threadId);
      return this.get(threadId, id);
    },

    end(threadId: string, id: string, exitCode: number, line: string | null): Run | null {
      db.prepare(
        `UPDATE runs SET ended_at = ?, last_activity_at = ?, exit_code = ?, last_line = COALESCE(?, last_line)
         WHERE id = ? AND thread_id = ? AND ended_at IS NULL`,
      ).run(now(), now(), exitCode, line === null ? null : clip(line, MAX_LINE), id, threadId);
      return this.get(threadId, id);
    },

    get(threadId: string, id: string): Run | null {
      const row = db.prepare(`SELECT * FROM runs WHERE id = ? AND thread_id = ?`).get(id, threadId) as Row | undefined;
      return row === undefined ? null : toRun(row);
    },

    setSandbox(threadId: string, id: string, sandboxId: string): void {
      db.prepare(`UPDATE runs SET sandbox_id = ? WHERE id = ? AND thread_id = ?`).run(sandboxId, id, threadId);
    },

    sandboxOf(threadId: string, id: string): string | null {
      const row = db.prepare(`SELECT sandbox_id FROM runs WHERE id = ? AND thread_id = ?`).get(id, threadId) as
        | { sandbox_id: string | null }
        | undefined;
      return row?.sandbox_id ?? null;
    },

    logPath(threadId: string, id: string): string | null {
      const row = db.prepare(`SELECT log_path FROM runs WHERE id = ? AND thread_id = ?`).get(id, threadId) as
        | { log_path: string | null }
        | undefined;
      return row?.log_path ?? null;
    },

    forThread(threadId: string, limit = 20): Run[] {
      const rows = db
        .prepare(`SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?`)
        .all(threadId, limit) as Row[];
      return rows.map(toRun);
    },

    /** Dismisses finished and lost runs; a run still reporting stays. */
    dismissFinished(threadId: string): number {
      return db
        .prepare(
          `UPDATE runs SET dismissed = 1
           WHERE thread_id = ? AND dismissed = 0
             AND (ended_at IS NOT NULL OR MAX(started_at, COALESCE(last_activity_at, 0)) < ?)`,
        )
        .run(threadId, now() - LOST_AFTER_MS).changes;
    },

    /** Runs older than the cutoff, removed from the table, with their log paths. */
    prune(olderThan: number): { id: string; logPath: string }[] {
      const rows = db.prepare(`SELECT id, log_path FROM runs WHERE started_at < ?`).all(olderThan) as {
        id: string;
        log_path: string | null;
      }[];
      db.prepare(`DELETE FROM runs WHERE started_at < ?`).run(olderThan);
      return rows.flatMap((row) => (row.log_path === null ? [] : [{ id: row.id, logPath: row.log_path }]));
    },
  };
}

export type RunStore = ReturnType<typeof createRunStore>;
