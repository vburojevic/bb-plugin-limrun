/**
 * Which threads build on Limrun.
 *
 * The switch is per thread. A thread that exists gets it set directly from
 * its composer. A thread that does not exist yet (the new-thread composer)
 * cannot be named, so that composer leaves a short-lived flag on its project;
 * the first message a person sends to a new thread of that project claims it
 * (the `message.dispatch` hook), before the agent's session starts.
 */
import type Database from "better-sqlite3";

export const MODE_MIGRATIONS = [
  `CREATE TABLE thread_modes (
     thread_id TEXT PRIMARY KEY,
     on_limrun INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE pending_modes (
     project_id TEXT PRIMARY KEY,
     set_at INTEGER NOT NULL
   )`,
];

/** A new-thread toggle left longer than this no longer applies. */
export const PENDING_FOR_MS = 30 * 60_000;

/** What the message.dispatch hook knows about one dispatch. */
export interface DispatchFacts {
  attempt: string;
  initiator: string;
  /** How the dispatch was requested; bb sets it for a new thread's first message, null for follow-ups. */
  origin: unknown;
  senderThreadId: string | null;
  threadCreatedAt: number;
  now: number;
}

/**
 * Whether a dispatch is a person's first message in a new thread, the only
 * one that may claim a project's new-thread flag. A follow-up in a recent
 * thread (origin null) or a thread an agent started (a sender thread) never does.
 */
export function isNewThreadStart(facts: DispatchFacts): boolean {
  return (
    facts.attempt === "start-turn" &&
    facts.initiator === "user" &&
    facts.origin !== null &&
    facts.senderThreadId === null &&
    facts.now - facts.threadCreatedAt < PENDING_FOR_MS
  );
}

export function createModeStore(db: Database.Database, now: () => number = Date.now) {
  return {
    isOn(threadId: string): boolean {
      const row = db.prepare(`SELECT on_limrun FROM thread_modes WHERE thread_id = ?`).get(threadId) as
        | { on_limrun: number }
        | undefined;
      return row?.on_limrun === 1;
    },

    /** Null when the thread was never switched either way. */
    known(threadId: string): boolean {
      return db.prepare(`SELECT 1 FROM thread_modes WHERE thread_id = ?`).get(threadId) !== undefined;
    },

    set(threadId: string, on: boolean): void {
      db.prepare(
        `INSERT INTO thread_modes (thread_id, on_limrun, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET on_limrun = excluded.on_limrun, updated_at = excluded.updated_at`,
      ).run(threadId, on ? 1 : 0, now());
    },

    forget(threadId: string): void {
      db.prepare(`DELETE FROM thread_modes WHERE thread_id = ?`).run(threadId);
    },

    onThreads(): string[] {
      return (db.prepare(`SELECT thread_id FROM thread_modes WHERE on_limrun = 1`).all() as { thread_id: string }[]).map(
        (row) => row.thread_id,
      );
    },

    setPending(projectId: string, on: boolean): void {
      if (on) {
        db.prepare(
          `INSERT INTO pending_modes (project_id, set_at) VALUES (?, ?)
           ON CONFLICT(project_id) DO UPDATE SET set_at = excluded.set_at`,
        ).run(projectId, now());
      } else {
        db.prepare(`DELETE FROM pending_modes WHERE project_id = ?`).run(projectId);
      }
    },

    pending(projectId: string): boolean {
      const row = db.prepare(`SELECT set_at FROM pending_modes WHERE project_id = ?`).get(projectId) as
        | { set_at: number }
        | undefined;
      return row !== undefined && now() - row.set_at < PENDING_FOR_MS;
    },

    /** Takes the project's new-thread flag, if one is fresh. */
    claimPending(projectId: string): boolean {
      const fresh = this.pending(projectId);
      db.prepare(`DELETE FROM pending_modes WHERE project_id = ?`).run(projectId);
      return fresh;
    },
  };
}

export type ModeStore = ReturnType<typeof createModeStore>;
