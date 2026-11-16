/**
 * Stopping devices nobody needs any more, which is the plugin's main job
 * after showing them: Limrun bills every minute a device runs.
 *
 * Two paths:
 *
 * - `stopThreadDevices` runs on `thread.archived` and `thread.deleted`. It
 *   deletes every live instance labeled with that thread, whoever started it.
 * - `sweep` runs at startup and on a schedule, because bb does not replay
 *   events a plugin missed while it was unloaded. It only considers devices
 *   this installation labeled (`bb-install`), so it never stops a device
 *   another bb or another person in the same Limrun org owns.
 */
import { INSTALL_LABEL, threadSelector } from "./labels";
import type { Device, DeviceKind, LimrunGateway } from "./limrun";

export type ThreadState = "open" | "archived" | "gone" | "unknown";

export interface CleanupLog {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

const KINDS: DeviceKind[] = ["ios", "xcode"];

async function removeAll(gateway: LimrunGateway, devices: Device[], log: CleanupLog, reason: string) {
  let stopped = 0;
  for (const device of devices) {
    try {
      await gateway.remove(device.kind, device.id);
      stopped += 1;
      log.info("stopped device", { id: device.id, kind: device.kind, threadId: device.threadId, reason });
    } catch (cause) {
      log.warn("could not stop device", {
        id: device.id,
        kind: device.kind,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return stopped;
}

export async function stopThreadDevices(
  gateway: LimrunGateway,
  threadId: string,
  log: CleanupLog,
  reason: string,
): Promise<number> {
  const devices: Device[] = [];
  for (const kind of KINDS) {
    devices.push(...(await gateway.list(kind, { labelSelector: threadSelector(threadId), live: true })));
  }
  return removeAll(gateway, devices, log, reason);
}

export async function sweep(
  gateway: LimrunGateway,
  installId: string,
  threadState: (threadId: string) => Promise<ThreadState>,
  log: CleanupLog,
): Promise<number> {
  const devices: Device[] = [];
  for (const kind of KINDS) {
    devices.push(...(await gateway.list(kind, { labelSelector: `${INSTALL_LABEL}=${installId}`, live: true })));
  }
  const states = new Map<string, ThreadState>();
  const doomed: Device[] = [];
  for (const device of devices) {
    // A device labeled by this install but naming no thread is the person's
    // own; leave it.
    if (device.threadId === null || device.installId !== installId) continue;
    let state = states.get(device.threadId);
    if (state === undefined) {
      state = await threadState(device.threadId);
      states.set(device.threadId, state);
    }
    if (state === "archived" || state === "gone") doomed.push(device);
  }
  return removeAll(gateway, doomed, log, "sweep");
}
