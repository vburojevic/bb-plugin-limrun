/**
 * The Build on Limrun switch, in the composer.
 *
 * In a thread's composer it switches that thread. In the new-thread composer
 * there is no thread yet, so it marks the selected project; the first message
 * sent to a new thread there claims the mark (server.ts, message.dispatch).
 * Flipped in a thread that already runs, it also adds a one-line note to the
 * person's draft, because an agent's standing instructions only change when
 * its session is next built.
 */
import { useComposer } from "@get-bb/plugin-sdk/app";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import { switchNote } from "../src/agent";
import { errorText, useLimrunQuery, useLimrunRpc } from "./hooks";

const TITLE_ON = "Build on Limrun is on: this thread's iOS builds, tests and simulators run in Limrun's cloud";
const TITLE_OFF = "Build on Limrun: run this thread's iOS builds, tests and simulators in Limrun's cloud";

export function ModeToggle() {
  const { scope } = useComposer();
  if (scope.kind === "thread") return <ThreadToggle threadId={scope.threadId} />;
  if (scope.kind === "new-thread" && scope.projectId !== null) return <NewThreadToggle projectId={scope.projectId} />;
  return null;
}

function Pill({ on, busy, onClick }: { on: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={on ? TITLE_ON : TITLE_OFF}
      disabled={busy}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground disabled:opacity-50",
        on && "bg-state-active text-foreground",
      )}
    >
      <Icon name="Cloud" className="size-3.5" />
      Limrun
    </button>
  );
}

function ThreadToggle({ threadId }: { threadId: string }) {
  const rpc = useLimrunRpc();
  const composer = useComposer();
  const mode = useLimrunQuery(() => rpc.call("thread_mode", { threadId }), { threadId, deps: [rpc, threadId] });
  const on = mode.data?.on ?? false;
  return (
    <Pill
      on={on}
      busy={mode.data === null}
      onClick={() => {
        rpc.call("set_thread_mode", { threadId, on: !on }).then(
          (next) => {
            composer.insert(`${switchNote(next.on)} `, { at: "end" });
            mode.refetch();
          },
          (cause) => console.warn("Limrun:", errorText(cause)),
        );
      }}
    />
  );
}

function NewThreadToggle({ projectId }: { projectId: string }) {
  const rpc = useLimrunRpc();
  const mode = useLimrunQuery(() => rpc.call("pending_mode", { projectId }), {
    threadId: null,
    deps: [rpc, projectId],
  });
  const on = mode.data?.on ?? false;
  return (
    <Pill
      on={on}
      busy={mode.data === null}
      onClick={() => {
        rpc.call("set_pending_mode", { projectId, on: !on }).then(mode.refetch, (cause) =>
          console.warn("Limrun:", errorText(cause)),
        );
      }}
    />
  );
}
