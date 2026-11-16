/**
 * The Limrun page in bb's sidebar: is Limrun connected, is the shim on,
 * what has the org spent, and which devices are running right now.
 */
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import type { DeviceDto, UsageDto } from "../src/contract";
import { deviceMinutes, deviceName, minutes, money, stateLabel } from "./format";
import { errorText, useLimrunQuery, useLimrunRpc, useNow } from "./hooks";

export function OrgPage() {
  const rpc = useLimrunRpc();
  const overview = useLimrunQuery(() => rpc.call("overview"), { threadId: null, deps: [rpc] });
  const org = useLimrunQuery(() => rpc.call("org"), { threadId: null, pollMs: 30_000, deps: [rpc] });
  const now = useNow(true, 30_000);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-6 p-4 md:p-5">
        <Section title="Connection">
          {overview.data === null ? (
            <Muted>{overview.error ?? "Checking…"}</Muted>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-2">
                <Icon name={overview.data.connected ? "CircleCheck" : "AlertCircle"} className="size-4" />
                {overview.data.connected
                  ? `Connected, using the key from ${overview.data.keySource === "env" ? "LIM_API_KEY" : "lim login"}.`
                  : overview.data.error}
              </p>
              <div className="space-y-1">
                <p className="flex items-center gap-2">
                  <Icon name={overview.data.shim.installed ? "CircleCheck" : "Circle"} className="size-4" />
                  {overview.data.shim.installed
                    ? overview.data.shim.current
                      ? "The lim shim is installed."
                      : "The lim shim is outdated. Run bb limrun shim install."
                    : "The lim shim is not installed. Without it, agents' devices and builds only show when they add the bb-thread label."}
                </p>
                {overview.data.shim.installed ? (
                  <p className="pl-6 text-xs text-muted-foreground">
                    It works in shells whose PATH starts with:{" "}
                    <code className="break-all">{overview.data.shim.pathLine}</code>
                  </p>
                ) : (
                  <p className="pl-6 text-xs text-muted-foreground">
                    Run <code>bb limrun shim install</code> and add the PATH line it prints.
                  </p>
                )}
              </div>
            </div>
          )}
        </Section>

        <Section title="Usage">
          {org.data === null ? (
            <Muted>{org.error ?? "Loading…"}</Muted>
          ) : org.data.error !== null ? (
            <Muted>{org.data.error}</Muted>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <UsageTile label="Today" usage={org.data.today} />
              <UsageTile label="This month" usage={org.data.month} />
            </div>
          )}
        </Section>

        <Section title="Running now">
          {org.data === null ? null : org.data.live.length === 0 ? (
            <Muted>No Limrun devices are running.</Muted>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {org.data.live.map((device) => (
                <LiveRow key={device.id} device={device} now={now} onStopped={org.refetch} />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function UsageTile({ label, usage }: { label: string; usage: UsageDto | null }) {
  if (usage === null) {
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-sm text-muted-foreground">Not available</p>
      </div>
    );
  }
  const billed = usage.ios.billedMinutes + usage.xcode.billedMinutes;
  const cost = usage.ios.cost + usage.xcode.cost;
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-medium tabular-nums">{money(cost)}</p>
      <p className="text-xs text-muted-foreground tabular-nums">
        {Math.round(billed)} billed min · {plural(usage.ios.count, "simulator")} · {plural(usage.xcode.count, "sandbox", "sandboxes")}
      </p>
    </div>
  );
}

function LiveRow({ device, now, onStopped }: { device: DeviceDto; now: number; onStopped: () => void }) {
  const rpc = useLimrunRpc();
  const navigate = useBbNavigate();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadId = device.threadId;

  return (
    <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
      <Icon name={device.kind === "xcode" ? "Build" : "Smartphone"} className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate">{device.displayName ?? deviceName(device)}</p>
        <p className="truncate text-xs text-muted-foreground">
          {deviceName(device)} · {stateLabel(device)} · {minutes(deviceMinutes(device, now))}
          {threadId === null ? " · not from a bb thread" : ""}
          {error === null ? "" : ` · ${error}`}
        </p>
      </div>
      {threadId !== null ? (
        <Button size="sm" variant="ghost" onClick={() => navigate.toThread(threadId)}>
          Open thread
        </Button>
      ) : null}
      {threadId !== null ? (
        confirming ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() =>
              rpc.call("stop_labeled_device", { id: device.id }).then(onStopped, (cause) => {
                setError(errorText(cause));
                setConfirming(false);
              })
            }
          >
            Stop it
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Stop
          </Button>
        )
      ) : null}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
