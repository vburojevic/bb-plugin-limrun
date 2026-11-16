/**
 * How a Limrun instance is tied to a bb thread.
 *
 * Two labels, both plain `key=value` strings on the instance:
 *
 * - `bb-thread` names the thread that owns the device. The shim adds it to
 *   every `lim … create`, the plugin adds it to devices it starts, and an agent
 *   without the shim adds it by hand (the skill says how). Archiving or
 *   deleting that thread deletes every live instance carrying it.
 * - `bb-install` names the bb installation that labeled it. Only the startup
 *   and periodic sweep needs it: a sweep deletes devices whose thread this bb
 *   no longer knows, and must never touch devices another bb (another Mac,
 *   another person in the same Limrun org) owns.
 */
export const THREAD_LABEL = "bb-thread";
export const INSTALL_LABEL = "bb-install";

const THREAD_ID = /^thr_[A-Za-z0-9_-]{1,64}$/;

/** True for a value that looks like a bb thread id. */
export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID.test(value);
}

/** The owning thread, when the labels name one. */
export function threadOf(labels: Record<string, string> | undefined): string | null {
  const value = labels?.[THREAD_LABEL];
  return isThreadId(value) ? value : null;
}

export function installOf(labels: Record<string, string> | undefined): string | null {
  const value = labels?.[INSTALL_LABEL];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Labels for a device a thread owns. Existing unrelated labels are kept. */
export function ownedLabels(
  existing: Record<string, string> | undefined,
  threadId: string,
  installId: string,
): Record<string, string> {
  return { ...existing, [THREAD_LABEL]: threadId, [INSTALL_LABEL]: installId };
}

/** A Limrun label selector for one thread's devices. */
export function threadSelector(threadId: string): string {
  return `${THREAD_LABEL}=${threadId}`;
}
