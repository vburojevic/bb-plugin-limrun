import type { DeviceDto, RunDto } from "../src/contract";
import { LOST_AFTER_MS } from "../src/runs";

/**
 * A run's status as of `now`. The server works "lost" out when it answers,
 * but an open card asks only on change signals, and a dead shim sends none.
 */
export function runStatus(run: RunDto, now: number): RunDto["status"] {
  return run.status === "running" && now - run.lastActivityAt > LOST_AFTER_MS ? "lost" : run.status;
}

export function deviceName(device: DeviceDto): string {
  if (device.kind === "xcode") return "Xcode sandbox";
  if (device.model === "ipad") return "iPad";
  if (device.model === "iphone") return "iPhone";
  return "Simulator";
}

export function isLive(device: DeviceDto): boolean {
  return device.state === "creating" || device.state === "assigned" || device.state === "ready";
}

export function stateLabel(device: DeviceDto): string {
  switch (device.state) {
    case "creating":
    case "assigned":
      return "Starting";
    case "ready":
      return "Running";
    case "terminating":
      return "Stopping";
    case "terminated":
      return endedLabel(device.terminationReason);
    default:
      return "Unknown";
  }
}

function endedLabel(reason: string | null): string {
  switch (reason) {
    case "UserRequested":
      return "Stopped";
    case "InactivityTimeout":
      return "Stopped when idle";
    case "HardTimeout":
      return "Hit its time limit";
    case "CapacityTimeout":
      return "No capacity";
    default:
      return "Ended";
  }
}

export function minutes(value: number): string {
  if (value < 1) return "under a minute";
  const rounded = Math.round(value);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function elapsed(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function deviceMinutes(device: DeviceDto, now: number): number {
  const start = Date.parse(device.createdAt);
  const end = device.endedAt === null ? now : Date.parse(device.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return (end - start) / 60_000;
}

export function runVerb(run: RunDto): string {
  return run.kind === "test" ? "Tests" : "Build";
}

/** The card's title for a run, in plain words. */
export function runTitle(run: RunDto, now: number): string {
  const verb = runVerb(run);
  const took = elapsed(run.startedAt, run.endedAt ?? now);
  switch (runStatus(run, now)) {
    case "running":
      return run.kind === "test" ? `Running tests on Limrun · ${took}` : `Building on Limrun · ${took}`;
    case "passed":
      return `${verb} passed in ${took}`;
    case "failed":
      return `${verb} failed after ${took}`;
    case "interrupted":
      return `${verb} stopped after ${took}`;
    case "lost":
      return `${verb} lost track (no end reported)`;
  }
}

export function money(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
