# @cmdforge/acp-launch

Start a new [ACP](https://agentclientprotocol.com) session, configure it, optionally run a first prompt, then open the GitHub Copilot desktop app on that same session.

```bash
npx -y @cmdforge/acp-launch --agent Planner -f prompt.md
```

## How it works

Built on the official [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk).

1. Spawns the agent (default `npx -y @github/copilot --acp`) and runs `initialize` + `session/new`.
2. Applies settings via `session/set_config_option` (falls back to `session/set_mode` for agents that only expose modes).
3. Sends the prompt with `session/prompt` and streams the reply to stdout.
4. Closes the session so it's flushed to `~/.copilot/session-state/<id>`, then opens `ghapp://sessions/<id>`. The desktop app reads that directory and opens the session.

## Hand off a task to the app

```bash
acp-launch --agent Planner --plan-first --no-mcp -f prompt.md
```

The ACP turn only plans (in plan mode, without MCP servers), then the session is switched back to agent mode and opened in the app. Read the plan there and reply (e.g. "go") to start the work with the app's own tools and MCP servers.

## Options

| Option | Description |
| --- | --- |
| `-p, --prompt <text>` | First prompt |
| `-f, --prompt-file <path>` | Read the first prompt from a file (`-` reads stdin) |
| `-c, --config <key=value>` | Set a session config option (repeatable). Keys match id, name, or category |
| `-m, --model <id>` / `--mode <id>` | Shorthands for `--config model=…` / `mode=…` |
| `-a, --agent <name>` | Shorthand for `--config agent=<name>`, e.g. `Planner` or `upgrade-agent:planner` |
| `--disable-mcp <name>` | Don't start this MCP server in the ACP session (repeatable), e.g. `workiq` to stop its sign-in page opening on every run. The app uses its own MCP setup when it resumes the session |
| `--no-mcp` | Don't start any MCP servers in the ACP session. Lists them with `copilot mcp list` and disables each (plus the built-in ones); overrides `--disable-mcp` |
| `--plan-first` | Run the prompt in plan mode, then switch back to the previous mode before opening the app, so the session arrives with a plan and nothing changed yet |
| `-C, --cwd <dir>` | Session working directory |
| `--permissions deny\|allow\|allow-always` | How to answer tool permission requests during the prompt (default `deny`) |
| `--list` | Print the settings the agent exposes and exit |
| `--no-login` | Fail instead of running the agent's login flow |
| `--json` | Print `{ sessionId, url, stopReason }` |

Use a different ACP agent by passing its command after `--`:

```bash
acp-launch -p "hi" -- my-agent --acp
```

## Notes

- If the agent says you're not signed in (ACP `auth_required`, or the 401/403 Copilot returns), acp-launch runs the agent's first advertised auth method, then restarts the agent and retries once:
  - terminal methods (typed `terminal`, or Copilot's `_meta["terminal-auth"]`) are run as a background command. Copilot's login uses the device flow (`--device-code`), so you can approve from any browser or profile, not just the account your default browser is signed in to. Copilot opens the verification page itself; acp-launch prints the code and copies it to the clipboard so it's ready to paste;
  - agent-handled methods are triggered with `authenticate`, and `elicitation/create` URL requests are opened in the browser.
- MCP servers that need OAuth (like the workiq plugin's) make Copilot's ACP mode open their sign-in page on every new session; use `--disable-mcp` for those.
- Works on macOS, Windows, and Linux. On Windows, bare commands like `npx` are run through `cmd.exe` with quoted arguments, and URLs are opened with `rundll32 url.dll,FileProtocolHandler`.
- The CLI's `/app` command isn't exposed over ACP, so the app is opened via the `ghapp://` deep link instead.
- The app is opened once the prompt turn has finished and the session is closed, so it resumes the session with its full history, agent, and model.
- Run `copilot login` once per machine first. The desktop app's login isn't shared with the CLI.

## Development

```bash
npm install
npm run build   # tsc -> dist/
node dist/cli.js --help
```

## Publishing

Releases are published by [.github/workflows/publish.yml](.github/workflows/publish.yml) when a version tag is pushed, using npm trusted publishing (the repository and `publish.yml` are registered as a trusted publisher on npmjs.com, so no token is needed).

To release: bump the version (`npm version patch`, which commits and tags `v<version>`), then `git push --follow-tags`. The workflow fails if the tag (`v<version>`) doesn't match `package.json`.

## Programmatic use

```js
import { launch } from '@cmdforge/acp-launch';

const { sessionId, url } = await launch({ config: [['mode', 'plan']], prompt: 'Plan a refactor' });
```
