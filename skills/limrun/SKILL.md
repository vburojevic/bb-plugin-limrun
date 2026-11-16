---
name: limrun
description: How Limrun cloud simulators and remote Xcode builds work inside bb. Use whenever you run the lim CLI from a bb thread (lim ios create, lim xcode build, lim xcode test), so the device shows in the thread's Limrun panel, its builds show above the composer, and it stops when the thread is archived. Also covers bb limrun commands.
---

# Limrun in bb

Drive devices and builds with Limrun's own `lim` CLI and Limrun's skills. This
skill only adds what bb needs on top.

## Every device belongs to this thread

bb finds a thread's devices by the label `bb-thread=$BB_THREAD_ID`. A labeled
simulator streams in the thread's **Limrun** side panel, where the person can
watch and touch it, and every labeled device stops when the thread is archived.

- Run `bb limrun status` first. It says whether the lim shim is on.
- **Shim on:** it adds the label to `lim ios create` and `lim xcode create`, and
  labels devices lim creates on its own (a build with no sandbox yet). Type
  plain `lim`.
- **Shim off:** add the label yourself, every time you create:

  ```sh
  lim ios create --reuse-if-exists --label bb-thread=$BB_THREAD_ID
  lim xcode create --reuse-if-exists --label bb-thread=$BB_THREAD_ID
  ```

  Prefer `--reuse-if-exists` with the label over a second device: one simulator
  per thread is the norm, and Limrun bills every minute each one runs.
- Never use another label scheme for ownership (Limrun's skills suggest
  `--label issue=<id>`; add it if you like, but keep `bb-thread`).

## Remote builds show above the composer

With the shim on, every `lim xcode build` and `lim xcode test` appears as a
live card above the composer with its last log line and, at the end, a pass or
fail verdict. You still read the result from lim's own output; the card is for
the person.

## Stopping devices

- `bb limrun devices` lists this thread's devices; `bb limrun stop <id>` stops
  one. You can only stop this thread's devices.
- Stop a device you are done with instead of leaving it to the idle timeout.
- Never delete devices with `lim ios delete` unless you created them in this
  thread: other threads and people share the Limrun org.

## When something is off

- `bb limrun status` says "not connected": the person must run `lim login` on
  the Mac running bb. Do not ask for the API key and never print it.
- The panel shows nothing after `lim ios create`: the device has no
  `bb-thread` label. Recreate it with the label, or ask the person to run
  `bb limrun shim install`.
