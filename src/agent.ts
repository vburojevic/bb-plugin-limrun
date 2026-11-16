/**
 * What a thread that builds on Limrun hands its agent: an environment that
 * points `lim` at the bb server's proxy, and instructions any agent can
 * follow (Claude Code, Codex, an ACP agent), with no shell setup on the
 * machine the thread runs on.
 */
import type { ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";

/** The lim version the instructions fall back to through npx; tested with the proxy. */
export const LIM_VERSION = "0.57.3";

/** Agent providers bb ships; each needs its own environment resolver. */
export const PROVIDER_IDS = ["claude-code", "codex", "acp-cursor"] as const;

export const CAPS = { ios: 2, xcode: 1 } as const;

export function proxyServerPath(pluginId: string): string {
  // bb expands a serverPath on the thread's machine against its own
  // BB_SERVER_URL, so this reaches the proxy from any enrolled machine.
  return `/api/v1/plugins/${pluginId}/http/lim?p=`;
}

export function agentEnv(pluginId: string, threadId: string, token: string): ExperimentalPluginProviderEnvEntry[] {
  return [
    {
      name: "LIM_API_ENDPOINT",
      value: { serverPath: proxyServerPath(pluginId) },
      reason: "Build on Limrun: lim talks to Limrun through the bb server, which adds the key and the thread's labels",
    },
    {
      name: "LIM_API_KEY",
      value: token,
      reason: "Build on Limrun: a token for this thread alone; the real Limrun key stays on the bb server",
    },
    {
      name: "LIM_WORKSPACE",
      value: `bb-${threadId}`,
      reason: "Build on Limrun: lim remembers this thread's devices apart from other threads in the same checkout",
    },
  ];
}

export function agentInstructions(): string {
  const lim = `lim (if it is not installed, run npx -y lim@${LIM_VERSION} instead)`;
  return [
    "This bb thread builds on Limrun. For iOS, iPadOS and watchOS targets, build, test and run only in Limrun's cloud with " +
      lim +
      ":",
    "- Build: `lim xcode build . --scheme <Scheme> --sdk iphonesimulator`. Test: `lim xcode test . --scheme <Scheme>`.",
    "- Run: `lim ios create --attach --reuse-if-exists` once; after that every successful build installs and relaunches on that simulator. Look and act with `lim ios screenshot`, `lim ios element-tree` and `lim ios tap-element`.",
    "- Never run local `xcodebuild`, `xcrun simctl` or a local Simulator for those targets. macOS targets still build locally: Limrun has no macOS SDK.",
    "- bb already set up lim for this thread through LIM_API_ENDPOINT, LIM_API_KEY and LIM_WORKSPACE. Never run `lim login`, change those variables, or print LIM_API_KEY.",
    `- Everything you create belongs to this thread: the person watches the simulator in the thread's Limrun tab, builds show above the composer, and all of it stops when the thread is archived. At most ${CAPS.ios} simulators and ${CAPS.xcode} Xcode sandbox run at a time; stop one you no longer need with \`lim ios delete <id>\`.`,
  ].join("\n");
}

/** Inserted into the person's next message when the switch flips mid-thread. */
export function switchNote(on: boolean): string {
  return on
    ? "(Build on Limrun is now on for this thread: build, test and run iOS targets only with lim, never local xcodebuild or simulators.)"
    : "(Build on Limrun is now off for this thread: lim no longer reaches Limrun here.)";
}
