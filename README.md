<h1 align="center">Limrun for bb</h1>

<p align="center"><b>Turn on Build on Limrun for a thread, and its agent builds, tests and runs iOS apps in <a href="https://limrun.com">Limrun</a>'s cloud<br>instead of on your Mac. Watch the simulator beside the chat, follow builds above the composer, and nothing keeps running after the thread is archived.</b></p>

<p align="center">
<a href="https://getbb.app"><img src="https://img.shields.io/badge/bb-%E2%89%A5%200.49-57606a?style=flat-square" alt="Requires bb 0.49 or later"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-57606a?style=flat-square" alt="MIT license"></a>
</p>

- **Build on Limrun, per thread.** One toggle in the composer. With it on, bb hands the thread's agent (Claude Code, Codex, or an ACP agent) everything `lim` needs, plus instructions to build, test and run iOS targets only on Limrun. It works on whichever bb machine the thread runs, with nothing to install or sign in there.
- **The simulator beside the chat.** The thread's Limrun tab streams its simulator with touch and keyboard. You can also start an iPhone or iPad there yourself.
- **Builds above the composer.** Each remote build and test shows live, then passes or fails, with its log one click away.
- **No forgotten devices.** Archiving or deleting a thread stops every simulator and Xcode sandbox labeled with it: those started with Build on Limrun on, from its Limrun tab, or by an agent that added the `bb-thread` label itself. For devices started through bb, a sweep every 15 minutes also catches an archive the plugin missed while it was not running.
- **A Limrun page** in the sidebar: connect, see what Limrun cost today and this month, and stop anything running.

## Get started

1. Install the plugin:

   ```sh
   bb plugin install vburojevic/bb-plugin-limrun
   ```

2. Open the Limrun page in bb's sidebar and paste a Limrun API key (console.limrun.com, Settings, API Keys).
3. In a new or existing thread of an iOS project, turn on the Limrun button in the composer (Limrun's `[ ]` mark; it turns orange when on), and ask the agent to build or run the app.

That's all. You don't need `lim login`, PATH changes, or per-machine setup. Agents use `lim` if it's installed and otherwise run it through `npx` (Node 20 or later).

## How it works

```text
agent's lim ──▶ bb server (the plugin's proxy) ──▶ api.limrun.com
   │               adds the API key, the thread's labels,
   │               and allows only this thread's devices
   └──────────────▶ the device itself (build sync, screen, taps), with its own instance token
```

- **The key stays on the bb server.** bb shows the environment it gives an agent in the thread's timeline, so the agent never gets the key. It gets `LIM_API_ENDPOINT`, pointing at the plugin's proxy route on the bb server, and a `LIM_API_KEY` token that works only through that proxy and only for that thread.
- **Labels make ownership.** The proxy adds `bb-thread=<thread id>` and `bb-install=<id>` to every device the thread creates. The thread can list, use and stop only its own devices, plus upload assets. Everything else in the Limrun org is refused. Each thread runs at most 2 simulators and 1 Xcode sandbox at a time.
- **Builds are followed from the server.** For each Xcode sandbox of a Build on Limrun thread, the plugin reads Limrun's build stream and verdict (`SUCCEEDED`, `FAILED`, `CANCELLED`) for the build card. Nothing is installed on the thread's machine.
- **New threads.** The toggle in the new-thread composer marks the selected project for 30 minutes. The first message you send in a new thread there switches that thread on before its agent starts.
- **Mid-thread.** Flipping the toggle in a running thread also adds a one-line note to your next message, because an agent's standing instructions only change when its session restarts.

## Commands

```text
bb limrun status       connection, whether this thread builds on Limrun, its devices
bb limrun devices      this thread's devices (live first, then recently ended)
bb limrun runs         this thread's remote builds and tests
bb limrun stop <id>    stop one of this thread's devices (the Limrun page stops any of this bb's)
```

Every command takes `--json`.

## Good to know

- iOS, iPadOS and watchOS only. macOS targets still build locally: Limrun's Xcode sandboxes have no macOS SDK. Android is not covered.
- A sandboxed agent shell needs network access to `*.limrun.com` and `*.limrun.net`, where builds sync and simulators stream.
- `lim` reaches the proxy through `LIM_API_ENDPOINT`, which `lim` reads but Limrun doesn't document. The plugin pins and tests `lim` 0.57.3.
- Without a key pasted in bb, the plugin falls back to `LIM_API_KEY` in the bb server's environment, then to `lim login` on the bb server's Mac.
- v0.1's `lim` shim is retired. v0.2 deletes the shim file, so remove the `bb Limrun plugin` PATH line from your shell profile if you added it.

## Development

```sh
npm install
npm run check                                    # typecheck and unit tests
npm run check:install                            # build the way bb's git install does (committed files only)
LIMRUN_LIVE=1 npx vitest run test/live.test.ts   # one short real iPhone session
bb plugin build
```

## License

MIT
