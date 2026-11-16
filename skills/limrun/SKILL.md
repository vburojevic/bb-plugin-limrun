---
name: limrun
description: How Limrun cloud simulators and remote Xcode builds work in bb threads, through the Limrun plugin's Build on Limrun mode. Use when a thread mentions Limrun, lim, cloud simulators or remote iOS builds, or when bb's instructions say this thread builds on Limrun. Also covers bb limrun commands.
---

# Limrun in bb

## Build on Limrun is a per-thread switch

The person turns it on with the Limrun toggle in the thread's composer. When
it is on, bb has already set up `lim` for the thread (LIM_API_ENDPOINT,
LIM_API_KEY, LIM_WORKSPACE) and its instructions tell you how to build. Use
`lim` if it is installed, otherwise `npx -y lim@0.57.3`.

- Build: `lim xcode build . --scheme <Scheme> --sdk iphonesimulator`
- Test: `lim xcode test . --scheme <Scheme>`
- Run: `lim ios create --attach --reuse-if-exists` once; every successful
  build then installs and relaunches on that simulator.
- Never run local `xcodebuild`, `xcrun simctl` or a local Simulator for iOS,
  iPadOS or watchOS targets in such a thread. macOS targets build locally.
- Never run `lim login`, change the LIM_* variables, or print LIM_API_KEY. It
  is a token for this thread only; the real key stays on the bb server.

Everything you create belongs to the thread: the person watches the simulator
in the thread's Limrun tab, builds show above the composer, and it all stops
when the thread is archived. A thread can see and stop only its own devices,
and runs at most 2 simulators and 1 Xcode sandbox at a time.

## When the switch is off

`lim` does not reach Limrun through bb. If the person asks for Limrun, ask
them to turn on the Limrun toggle in the composer; do not sign in yourself.

If this machine's `lim` is already signed in and you use it anyway, add
`--label bb-thread=$BB_THREAD_ID` to every `lim ios create` and
`lim xcode create`. Only labeled devices show in the thread's Limrun tab and
stop when the thread is archived; an unlabeled one keeps billing.

## Commands

- `bb limrun status`: connection, whether this thread builds on Limrun, its devices.
- `bb limrun devices`, `bb limrun runs`: this thread's devices and remote builds.
- `bb limrun stop <id>`: stop one of this thread's devices.

## Sandboxed shells

Builds and simulators stream to `*.limrun.com` and `*.limrun.net`. A shell
sandbox that blocks those hosts makes `lim xcode build` fail; say so instead
of retrying.
