/**
 * Remote builds and tests above the thread's composer.
 *
 * Shows while a `lim xcode build` or `lim xcode test` the shim reported is
 * running, and keeps the verdict until it is dismissed or 30 minutes pass.
 * It reads only the plugin's own run table, so it costs no Limrun calls.
 */
import { useState } from "react";
import {
  experimental_CollapsibleStackCard as CollapsibleStackCard,
  experimental_useAppPanel as useAppPanel,
  useComposer,
} from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import type { RunDto } from "../src/contract";
import { elapsed, runStatus, runTitle } from "./format";
import { errorText, useLimrunQuery, useLimrunRpc, useNow } from "./hooks";

const KEEP_FINISHED_MS = 30 * 60_000;
export const DEVICE_TAB = { id: "device", context: { kind: "thread" }, availability: "action" } as const;

export function RunsBanner() {
  const { scope } = useComposer();
  return scope.kind === "thread" ? <RunsCard threadId={scope.threadId} /> : null;
}

function visibleRuns(runs: RunDto[], now: number): RunDto[] {
  return runs
    .map((run) => ({ ...run, status: runStatus(run, now) }))
    .filter((run) => run.status === "running" || (!run.dismissed && now - run.lastActivityAt < KEEP_FINISHED_MS));
}

function RunsCard({ threadId }: { threadId: string }) {
  const rpc = useLimrunRpc();
  const panel = useAppPanel();
  const { data } = useLimrunQuery(() => rpc.call("thread_runs", { threadId }), { threadId, deps: [rpc, threadId] });
  const reporting = (data?.runs ?? []).some((run) => run.status === "running");
  const now = useNow(reporting || (data?.runs.length ?? 0) > 0, reporting ? 1000 : 30_000);
  const runs = visibleRuns(data?.runs ?? [], now);
  const running = runs.some((run) => run.status === "running");
  if (runs.length === 0) return null;

  const lead = runs.find((run) => run.status === "running") ?? runs[0]!;
  const failed = lead.status === "failed" || lead.status === "lost";

  return (
    <CollapsibleStackCard
      label="Limrun builds"
      title={runTitle(lead, now)}
      icon={
        lead.status === "running"
          ? lead.kind === "test"
            ? "Test"
            : "Build"
          : failed
            ? "CircleX"
            : lead.status === "passed"
              ? "CircleCheck"
              : "CircleDashed"
      }
      isActive={lead.status === "running"}
      dismiss={
        running
          ? undefined
          : {
              label: "Dismiss build results",
              failureMessage: "Could not dismiss the build results.",
              onDismiss: async () => {
                await rpc.call("dismiss_runs", { threadId });
              },
            }
      }
    >
      <div className="space-y-2 px-3 pt-1 pb-2">
        {runs.map((run) => (
          <RunRow key={run.id} threadId={threadId} run={run} now={now} />
        ))}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => panel.openTab({ tab: DEVICE_TAB })}>
            <Icon name="Smartphone" />
            Open Limrun device
          </Button>
        </div>
      </div>
    </CollapsibleStackCard>
  );
}

function RunRow({ threadId, run, now }: { threadId: string; run: RunDto; now: number }) {
  const rpc = useLimrunRpc();
  const [log, setLog] = useState<{ text: string; truncated: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    if (open) return setOpen(false);
    setOpen(true);
    rpc.call("run_log", { threadId, runId: run.id }).then(setLog, (cause) => setError(errorText(cause)));
  };

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            run.status === "running" && "animate-pulse bg-foreground",
            run.status === "passed" && "bg-[var(--success)]",
            (run.status === "failed" || run.status === "lost") && "bg-destructive",
            run.status === "interrupted" && "bg-muted-foreground",
          )}
          aria-hidden
        />
        <code className="min-w-0 flex-1 truncate text-muted-foreground" title={run.command}>
          {run.command}
        </code>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {elapsed(run.startedAt, run.endedAt ?? now)}
        </span>
        <button className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={toggle}>
          {open ? "Hide log" : "Log"}
        </button>
      </div>
      {run.lastLine !== null && !open ? (
        <p className="mt-1 truncate pl-3.5 font-mono text-muted-foreground" title={run.lastLine}>
          {run.lastLine}
        </p>
      ) : null}
      {open ? (
        <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {error ?? (log === null ? "Loading…" : `${log.truncated ? "…\n" : ""}${log.text}`)}
        </pre>
      ) : null}
    </div>
  );
}
