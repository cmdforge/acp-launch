# @cmdforge/acp-launch

Start a new [ACP](https://agentclientprotocol.com) session, configure it, optionally run a first prompt, then open the GitHub Copilot desktop app on that same session.

```bash
npx -y @cmdforge/acp-launch --agent reviewer -p "Review the open changes"
```

## How it works

Built on the official [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk).

1. Spawns the agent (default `npx -y @github/copilot --acp`) and runs `initialize` + `session/new`.
2. Applies settings via `session/set_config_option` (falls back to `session/set_mode` for agents that only expose modes).
3. Sends the prompt with `session/prompt` and streams the reply to stdout.
4. Closes the session so it's flushed to `~/.copilot/session-state/<id>`, then opens `ghapp://sessions/<id>`. The desktop app reads that directory and opens the session.

## Options

| Option | Description |
| --- | --- |
| `-p, --prompt <text>` | First prompt (`-` reads stdin) |
| `-c, --config <key=value>` | Set a session config option (repeatable). Keys match id, name, or category |
| `-m, --model <id>` / `--mode <id>` | Shorthands for `--config model=…` / `mode=…` |
| `-a, --agent <name>` | Custom agent. With the default command it's passed as `copilot --agent <name>`; with a custom command it's `--config agent=<name>` |
| `-C, --cwd <dir>` | Session working directory |
| `--open after\|before\|never` | Open the app after the turn (default), before it, or not at all |
| `--url <template>` | Deep link, `{id}` is the session id (default `ghapp://sessions/{id}`) |
| `--permissions deny\|allow\|allow-always` | How to answer tool permission requests during the prompt (default `deny`) |
| `--list` | Print the settings the agent exposes and exit |
| `--json` | Print `{ sessionId, url, stopReason }` |

Use a different ACP agent by passing its command after `--`:

```bash
acp-launch -p "hi" --open never -- my-agent --acp
```

## Notes

- The Copilot CLI must be logged in (`npx -y @github/copilot login`); otherwise `session/new` fails with 403.
- The CLI's `/app` command isn't exposed over ACP, so the app is opened via the `ghapp://` deep link instead.
- With `--open before`, the app opens while this process still owns the session; whether the app shows the turn live depends on the app.

## Development

```bash
npm install
npm run build   # tsc -> dist/
node dist/cli.js --help
```

## Programmatic use

```js
import { launch } from '@cmdforge/acp-launch';

const { sessionId, url } = await launch({ config: [['mode', 'plan']], prompt: 'Plan a refactor' });
```
