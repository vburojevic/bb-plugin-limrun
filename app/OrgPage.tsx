/**
 * The Limrun page in bb's sidebar: is Limrun connected,
 * what has the org spent, and which devices are running right now.
 */
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

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
            <Connection overview={overview.data} onChanged={overview.refetch} />
          )}
        </Section>

        <Section title="Usage">
          {org.data === null ? (
            <Muted>{org.error ?? "Loading…"}</Muted>
          ) : org.data.error !== null ? (
            <Muted>{overview.data?.connected === false ? "Connect Limrun to see usage." : org.data.error}</Muted>
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
                <LiveRow
                  key={device.id}
                  device={device}
                  now={now}
                  ours={device.installId === org.data!.installId}
                  onStopped={org.refetch}
                />
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

const SOURCE: Record<string, string> = {
  bb: "the key saved in bb",
  env: "LIM_API_KEY on the bb server",
  "lim-config": "lim login on the bb server's Mac",
};

function Connection({
  overview,
  onChanged,
}: {
  overview: { connected: boolean; keySource: string | null; error: string | null };
  onChanged: () => void;
}) {
  const rpc = useLimrunRpc();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (key.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("set_api_key", { key: key.trim() });
      if (result.connected) {
        setKey("");
        onChanged();
      } else {
        setError(result.error);
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  if (overview.connected) {
    return (
      <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <Icon name="CircleCheck" className="size-4" />
        <span className="min-w-0 flex-1">Connected, using {SOURCE[overview.keySource ?? ""] ?? "a Limrun key"}.</span>
        {overview.keySource === "bb" ? (
          confirming ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() =>
                  void rpc.call("clear_api_key").then(
                    () => {
                      setConfirming(false);
                      onChanged();
                    },
                    (cause) => {
                      setConfirming(false);
                      setError(errorText(cause));
                    },
                  )
                }
              >
                Remove the key
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Remove key
            </Button>
          )
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={save} className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Paste a Limrun API key to connect. Create one at{" "}
        <a href="https://console.limrun.com" target="_blank" rel="noreferrer" className="underline underline-offset-2">
          console.limrun.com
        </a>{" "}
        under Settings, API Keys. It stays on the bb
        server; agents and this page never see it again.
      </p>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="lim_…"
          aria-label="Limrun API key"
        />
        <Button type="submit" disabled={busy || key.trim() === ""}>
          {busy ? "Checking…" : "Connect"}
        </Button>
      </div>
      {error !== null || (overview.keySource !== null && overview.error !== null) ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? overview.error}
        </p>
      ) : null}
    </form>
  );
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

function LiveRow({
  device,
  now,
  ours,
  onStopped,
}: {
  device: DeviceDto;
  now: number;
  ours: boolean;
  onStopped: () => void;
}) {
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
          {threadId === null ? " · not from a bb thread" : ours ? "" : " · another bb's device"}
          {error === null ? "" : ` · ${error}`}
        </p>
      </div>
      {ours && threadId !== null ? (
        <Button size="sm" variant="ghost" onClick={() => navigate.toThread(threadId)}>
          Open thread
        </Button>
      ) : null}
      {ours && threadId !== null ? (
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
