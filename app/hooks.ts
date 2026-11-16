import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";

import { CHANGED_CHANNEL, type RpcContract } from "../src/contract";

export function useLimrunRpc() {
  return useRpc<RpcContract>();
}

export function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) return String(cause.message);
  return String(cause);
}

/** A ticking clock for elapsed times; ticks only while `active`. */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

/**
 * One RPC read, refetched on the plugin's change signal for `threadId` (or
 * any thread when `threadId` is null) and, optionally, on a timer. Devices an
 * agent starts with plain `lim` and no shim send no signal, so the panel
 * also polls while it is open.
 */
export function useLimrunQuery<T>(
  load: () => Promise<T>,
  options: { threadId: string | null; pollMs?: number; deps: unknown[] },
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const inFlight = useRef(false);

  const refetch = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    loadRef.current().then(
      (value) => {
        inFlight.current = false;
        setData(value);
        setError(null);
      },
      (cause) => {
        inFlight.current = false;
        setError(errorText(cause));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, options.deps);

  useEffect(() => {
    setData(null);
    refetch();
  }, [refetch]);

  useRealtime(CHANGED_CHANNEL, (payload: unknown) => {
    const changed = (payload as { threadId?: string | null } | null)?.threadId ?? null;
    if (options.threadId === null || changed === null || changed === options.threadId) refetch();
  });

  useEffect(() => {
    if (!options.pollMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refetch();
    }, options.pollMs);
    return () => clearInterval(timer);
  }, [options.pollMs, refetch]);

  return { data, error, refetch };
}
