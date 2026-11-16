<h1 align="center">Limrun for bb</h1>

<p align="center"><b>See and steer a thread's <a href="https://limrun.com">Limrun</a> cloud simulator beside the chat,<br>follow its remote Xcode builds above the composer, and stop its devices when the thread is archived.</b></p>

<p align="center">
<a href="https://getbb.app"><img src="https://img.shields.io/badge/bb-%E2%89%A5%200.49-57606a?style=flat-square" alt="Requires bb 0.49 or later"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-57606a?style=flat-square" alt="MIT license"></a>
</p>

Agents keep driving devices with Limrun's own `lim` CLI and Limrun's skills. This plugin adds what only bb can show:

- **A Limrun tab in every thread.** The thread's simulator streams beside the conversation with touch and keyboard. Start an iPhone or iPad from the tab, or let the agent run `lim ios create`; it shows up either way. Stop it with two clicks.
- **Remote builds above the composer.** Each `lim xcode build` and `lim xcode test` shows as a live card with its last log line, then a pass or fail verdict and the full log.
- **No forgotten devices.** Archiving or deleting a thread stops its simulators and Xcode sandboxes. A sweep every 15 minutes catches archives that happened while the plugin was not running.
- **A Limrun page in the sidebar** with the connection, the org's spend today and this month, and every device running right now.

## Install

```sh
bb plugin install vburojevic/bb-plugin-limrun
```

Then, on the Mac that runs bb:

```sh
npm install --global lim     # Limrun's CLI, Node 20 or later
lim login                    # or set LIM_API_KEY for the bb server
bb limrun shim install       # optional, recommended: prints a PATH line for your shell profile
```

The plugin uses the same API key as `lim`: `LIM_API_KEY` in the bb server's environment, otherwise the key `lim login` saved in `~/.lim/config.yaml`. The key never leaves the server. The browser only gets one simulator's stream URL and its stream-only token.

For agents, install Limrun's own skills too (`lim skills install --agents claude`), or its Claude Code plugin (`/plugin marketplace add limrun-inc/skills`, then `/plugin install limrun@limrun`).

## How a device finds its thread

A thread's devices are the Limrun instances labeled `bb-thread=<thread id>`. Three things add that label:

| Who creates the device | How it gets the label |
| --- | --- |
| The Limrun tab's Start buttons | The plugin labels it. |
| An agent, with the shim on | The shim adds `--label bb-thread=…` to `lim ios create` and `lim xcode create`, and labels devices `lim` creates on its own (a build with no sandbox yet). |
| An agent, without the shim | The bundled skill tells the agent to add `--label bb-thread=$BB_THREAD_ID` itself. |

The plugin also adds `bb-install=<id>`, naming this bb installation. The periodic sweep only stops devices with this installation's label, so it never touches devices another bb or another person in the same Limrun org started.

## The `lim` shim

Limrun can't push build events to a bb on a laptop: its webhooks need a public HTTPS host. So the plugin learns about agents' devices and builds by standing in front of `lim` on `PATH`.

- It does nothing outside a bb thread, or with `BB_LIMRUN_SHIM=off`: it runs the real `lim` with the same arguments, output and exit code.
- Inside a thread it does three things. It adds the thread label to creates. It tees `lim xcode build` and `lim xcode test` output to `$TMPDIR/bb-limrun/<run>.log` and reports start, last line and exit code. It reports instance ids that appeared in `~/.lim/last-instances.json`.
- Every report is best effort with a timeout, and a failed log write never fails the command.

Commands: `bb limrun shim install`, `bb limrun shim status`, `bb limrun shim uninstall`.

## Sandboxed agents

An agent whose shell is sandboxed needs network access to `api.limrun.com`, `*.limrun.com` and `*.limrun.net`, or every `lim` command fails. Limrun's docs list the same hosts. The shim writes its build logs to the agent's own temp folder, which sandboxes allow.

## Commands

```text
bb limrun status            connection, shim, and this thread's devices
bb limrun devices           this thread's devices (live first, then recently ended)
bb limrun runs              this thread's remote builds and tests
bb limrun stop <id>         stop one of this thread's devices (the Limrun page stops any of this bb's)
bb limrun shim install|status|uninstall
```

Every command takes `--json`.

## Limits

- iOS only: simulators and Xcode sandboxes. Android emulators and Gradle sandboxes are not shown.
- The shim and the build logs live on the machine that runs the bb server. Threads on another enrolled machine get their devices labeled only when that machine's shell has the shim on `PATH`.
- Limrun is in early access, and its CLI changes quickly. The plugin pins `@limrun/api` 0.73.2 and `@limrun/ui` 0.20.6 and was checked against `lim` 0.57.3.

## Development

```sh
npm install
npm run check                                    # typecheck and unit tests
LIMRUN_LIVE=1 npx vitest run test/live.test.ts   # one short real iPhone session
bb plugin build
```

## License

MIT
