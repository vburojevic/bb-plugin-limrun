/**
 * The Build on Limrun switch, in the composer.
 *
 * In a thread's composer it switches that thread. In the new-thread composer
 * there is no thread yet, so it marks the selected project; the first message
 * sent to a new thread there claims the mark (server.ts, message.dispatch).
 * Flipped in a thread that already runs, it also leaves a one-line note at the
 * end of the person's draft, because an agent's standing instructions only
 * change when its session is next built. Flipping back removes that note.
 * While Limrun is not connected the pill stays off and leads to the Limrun page.
 */
import { useState } from "react";
import { useBbNavigate, useComposer } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import { switchNote } from "../src/agent";
import { errorText, useLimrunQuery, useLimrunRpc } from "./hooks";

const TITLES = {
  threadOn: "Build on Limrun is on: this thread's iOS builds, tests and simulators run in Limrun's cloud",
  threadOff: "Build on Limrun: run this thread's iOS builds, tests and simulators in Limrun's cloud",
  newOn: "The first message here starts a thread that builds on Limrun",
  newOff: "Build on Limrun: start this thread with iOS builds, tests and simulators in Limrun's cloud",
  connect: "Connect Limrun on the Limrun page first",
};

export function ModeToggle() {
  const { scope } = useComposer();
  const rpc = useLimrunRpc();
  const overview = useLimrunQuery(() => rpc.call("overview"), { threadId: null, deps: [rpc] });
  if (overview.data !== null && !overview.data.connected) return <ConnectPill />;
  if (scope.kind === "thread") return <ThreadToggle threadId={scope.threadId} />;
  if (scope.kind === "new-thread" && scope.projectId !== null) return <NewThreadToggle projectId={scope.projectId} />;
  return null;
}

function Pill({
  on,
  busy,
  title,
  onClick,
}: {
  on: boolean;
  busy: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <span title={title} className="inline-flex">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={on}
        aria-label="Build on Limrun"
        aria-description={title}
        disabled={busy}
        onClick={onClick}
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
      >
        <Icon name="Cloud" className="size-3.5" />
        Limrun
      </Button>
    </span>
  );
}

function ConnectPill() {
  const navigate = useBbNavigate();
  return <Pill on={false} busy={false} title={TITLES.connect} onClick={() => navigate.toPluginPanel("limrun")} />;
}

function ThreadToggle({ threadId }: { threadId: string }) {
  const rpc = useLimrunRpc();
  const composer = useComposer();
  const mode = useLimrunQuery(() => rpc.call("thread_mode", { threadId }), { threadId, deps: [rpc, threadId] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = mode.data?.on ?? false;

  const flip = () => {
    setBusy(true);
    setError(null);
    rpc.call("set_thread_mode", { threadId, on: !on }).then(
      (next) => {
        // A note for the opposite flip at the end of the draft cancels out:
        // the agent still knows the state it had. Otherwise add this flip's note.
        const opposite = switchNote(!next.on);
        const trimmed = composer.draft.text.trimEnd();
        if (trimmed.endsWith(opposite)) {
          composer.replace({ text: trimmed.slice(0, -opposite.length).trimEnd(), mentions: composer.draft.mentions });
        } else {
          composer.insert(trimmed === "" ? switchNote(next.on) : ` ${switchNote(next.on)}`, { at: "end" });
        }
        mode.refetch();
        setBusy(false);
      },
      (cause) => {
        setError(errorText(cause));
        setBusy(false);
      },
    );
  };

  return (
    <Pill
      on={on}
      busy={busy || mode.data === null}
      title={error ?? mode.error ?? (on ? TITLES.threadOn : TITLES.threadOff)}
      onClick={flip}
    />
  );
}

function NewThreadToggle({ projectId }: { projectId: string }) {
  const rpc = useLimrunRpc();
  // The mark lapses after 30 minutes; asking again each minute keeps the pill honest.
  const mode = useLimrunQuery(() => rpc.call("pending_mode", { projectId }), {
    threadId: null,
    pollMs: 60_000,
    deps: [rpc, projectId],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = mode.data?.on ?? false;
  return (
    <Pill
      on={on}
      busy={busy || mode.data === null}
      title={error ?? mode.error ?? (on ? TITLES.newOn : TITLES.newOff)}
      onClick={() => {
        setBusy(true);
        setError(null);
        rpc.call("set_pending_mode", { projectId, on: !on }).then(
          () => {
            mode.refetch();
            setBusy(false);
          },
          (cause) => {
            setError(errorText(cause));
            setBusy(false);
          },
        );
      }}
    />
  );
}
