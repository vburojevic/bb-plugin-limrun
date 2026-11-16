/**
 * The thread's Limrun tab: the simulator the thread owns, streamed with touch
 * and keyboard, plus start and stop. A thread's devices are the instances
 * labeled with its id, whoever started them: this panel, or the agent of a
 * thread that builds on Limrun (the server's proxy labels it).
 */
import { useEffect, useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { RemoteControl, type RemoteControlConnectionState } from "@limrun/ui/lite";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import type { DeviceDto } from "../src/contract";
import { deviceMinutes, deviceName, isLive, minutes, stateLabel } from "./format";
import { errorText, useLimrunQuery, useLimrunRpc, useNow } from "./hooks";

export function DevicePanel({ threadId }: { threadId: string }) {
  const rpc = useLimrunRpc();
  const state = useLimrunQuery(() => rpc.call("thread_state", { threadId }), {
    threadId,
    pollMs: 10_000,
    deps: [rpc, threadId],
  });
  const overview = useLimrunQuery(() => rpc.call("overview"), { threadId: null, deps: [rpc] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const devices = state.data?.devices ?? [];
  const simulators = devices.filter((device) => device.kind === "ios" && isLive(device));
  const sandboxes = devices.filter((device) => device.kind === "xcode" && isLive(device));
  const ended = devices.filter((device) => !isLive(device)).slice(0, 3);
  const selected = simulators.find((device) => device.id === selectedId) ?? simulators[0] ?? null;
  const starting = state.data?.starting ?? [];
  const now = useNow(simulators.length > 0 || sandboxes.length > 0, 30_000);

  const start = (model: "iphone" | "ipad") => {
    setActionError(null);
    rpc.call("start_device", { threadId, model }).then(
      (device) => {
        setSelectedId(device.id);
        state.refetch();
      },
      (cause) => setActionError(errorText(cause)),
    );
    // The server publishes a change as soon as the start begins.
    setTimeout(state.refetch, 300);
  };

  if (overview.data !== null && !overview.data.connected) {
    return <NotConnected message={overview.data.error} />;
  }
  if (state.data === null) {
    return (
      <Centered>
        {state.error === null ? (
          <p className="text-sm text-muted-foreground">Loading Limrun devices…</p>
        ) : (
          <ErrorNote message={state.error} onRetry={state.refetch} />
        )}
      </Centered>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {selected !== null ? (
        <>
          <DeviceHeader
            devices={simulators}
            selected={selected}
            onSelect={setSelectedId}
            now={now}
            onStop={(device) =>
              rpc.call("stop_device", { threadId, id: device.id }).then(state.refetch, (cause) => {
                setActionError(errorText(cause));
              })
            }
          />
          <div className="relative min-h-0 flex-1 bg-muted/40">
            {selected.state === "ready" ? (
              <Stream key={selected.id} threadId={threadId} device={selected} />
            ) : (
              <Centered>
                <p className="text-sm text-muted-foreground">Starting {deviceName(selected)}…</p>
              </Centered>
            )}
          </div>
        </>
      ) : (
        <EmptyState starting={starting} onStart={start} />
      )}

      {actionError !== null || state.data.error !== null ? (
        <p role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">
          {actionError ?? state.data.error}
        </p>
      ) : null}

      {sandboxes.length > 0 || ended.length > 0 ? (
        <div className="space-y-1 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {sandboxes.map((device) => (
            <p key={device.id} className="flex items-center gap-2">
              <Icon name="Build" className="size-3.5" />
              <span className="text-foreground">Xcode sandbox</span>
              <span>{stateLabel(device)}</span>
              <span>· {minutes(deviceMinutes(device, now))}</span>
            </p>
          ))}
          {ended.map((device) => (
            <p key={device.id} className="flex items-center gap-2">
              <Icon name="Clock" className="size-3.5" />
              <span>{deviceName(device)}</span>
              <span>{stateLabel(device)}</span>
              <span>· ran {minutes(deviceMinutes(device, now))}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DeviceHeader({
  devices,
  selected,
  onSelect,
  onStop,
  now,
}: {
  devices: DeviceDto[];
  selected: DeviceDto;
  onSelect: (id: string) => void;
  onStop: (device: DeviceDto) => Promise<unknown>;
  now: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    setConfirming(false);
    setStopping(false);
  }, [selected.id]);

  return (
    <div className="flex min-h-11 items-center gap-2 border-b border-border px-3 py-1.5">
      {devices.length > 1 ? (
        <div role="tablist" aria-label="Devices" className="flex min-w-0 gap-1 overflow-x-auto">
          {devices.map((device) => (
            <button
              key={device.id}
              role="tab"
              aria-selected={device.id === selected.id}
              onClick={() => onSelect(device.id)}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground",
                device.id === selected.id && "bg-state-active text-foreground",
              )}
            >
              {deviceName(device)}
            </button>
          ))}
        </div>
      ) : (
        <span className="text-sm font-medium">{deviceName(selected)}</span>
      )}
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {stateLabel(selected)} · {minutes(deviceMinutes(selected, now))}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {confirming ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={stopping}>
              Keep
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                void onStop(selected).finally(() => setStopping(false));
              }}
            >
              {stopping ? "Stopping…" : `Stop ${deviceName(selected)}`}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label="Stop this device">
            <Icon name="Square" />
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

function Stream({ threadId, device }: { threadId: string; device: DeviceDto }) {
  const rpc = useLimrunRpc();
  const [credentials, setCredentials] = useState<{ url: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<RemoteControlConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCredentials(null);
    setError(null);
    rpc.call("stream", { threadId, id: device.id }).then(
      (value) => !cancelled && setCredentials({ url: value.url, token: value.token }),
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, device.id, attempt]);

  const status = useMemo(() => {
    switch (connection) {
      case "connecting":
        return "Connecting…";
      case "reconnecting":
        return "Reconnecting…";
      case "failed":
        return "The stream dropped.";
      case "terminated":
        return "The device stopped.";
      default:
        return null;
    }
  }, [connection]);

  if (error !== null) {
    return (
      <Centered>
        <ErrorNote message={error} onRetry={() => setAttempt((value) => value + 1)} />
      </Centered>
    );
  }
  if (credentials === null) {
    return (
      <Centered>
        <p className="text-sm text-muted-foreground">Connecting…</p>
      </Centered>
    );
  }
  return (
    <div className="absolute inset-0 p-3">
      <RemoteControl
        url={credentials.url}
        token={credentials.token}
        className="limrun-stream h-full w-full"
        autoReconnect
        onConnectionStateChange={setConnection}
      />
      {status !== null && connection !== "connected" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
            {status}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({
  starting,
  onStart,
}: {
  starting: ("iphone" | "ipad")[];
  onStart: (model: "iphone" | "ipad") => void;
}) {
  return (
    <Centered>
      <div className="max-w-xs space-y-4 text-center">
        <div className="space-y-1">
          <p className="text-sm font-medium">No Limrun simulator in this thread</p>
          <p className="text-xs text-muted-foreground">
            Start one here, or turn on Limrun in the composer and ask the agent to run the app. It stops when
            the thread is archived.
          </p>
        </div>
        <div className="flex justify-center gap-2">
          {(["iphone", "ipad"] as const).map((model) => (
            <Button
              key={model}
              size="sm"
              variant={model === "iphone" ? "default" : "outline"}
              disabled={starting.length > 0}
              onClick={() => onStart(model)}
            >
              <Icon name="Smartphone" />
              {starting.includes(model) ? "Starting…" : model === "iphone" ? "Start iPhone" : "Start iPad"}
            </Button>
          ))}
        </div>
      </div>
    </Centered>
  );
}

function NotConnected({ message }: { message: string | null }) {
  const navigate = useBbNavigate();
  return (
    <Centered>
      <div className="max-w-sm space-y-3 text-center">
        <div className="space-y-1">
          <p className="text-sm font-medium">Limrun is not connected</p>
          <p className="text-xs text-muted-foreground">
            {message ?? "Paste a Limrun API key on the Limrun page to connect."}
          </p>
        </div>
        <Button size="sm" onClick={() => navigate.toPluginPanel("limrun")}>
          Open the Limrun page
        </Button>
      </div>
    </Centered>
  );
}

function ErrorNote({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="max-w-sm space-y-2 text-center">
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-40 items-center justify-center p-6">{children}</div>;
}
