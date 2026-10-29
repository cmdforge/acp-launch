#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { launch, DEFAULT_AGENT_COMMAND, type LaunchEvent, type PermissionPolicy } from './launch.js';

const HELP = `Usage: acp-launch [options] [-- <agent command...>]

Start an ACP session, configure it, optionally run a first prompt, then open
the session in the GitHub Copilot desktop app.

Options:
  -p, --prompt <text>       First prompt to send
  -f, --prompt-file <path>  Read the first prompt from a file ("-" reads stdin)
  -c, --config <key=value>  Set a session config option (repeatable). Keys match an
                            option's id, name, or category; values match id or name.
  -m, --model <id>          Shorthand for --config model=<id>
      --mode <id>           Shorthand for --config mode=<id>
  -a, --agent <name>        Shorthand for --config agent=<name>
      --disable-mcp <name>  Don't start this MCP server in the ACP session (repeatable).
                            Avoids sign-in pages from servers like workiq; the app
                            uses its own MCP setup when it resumes the session
  -C, --cwd <dir>           Session working directory (default: current directory)
      --permissions <mode>  Answer tool permission requests during the prompt with
                            deny (default), allow, or allow-always
      --list                Create a session and print the settings it exposes
      --no-login            Fail instead of running the agent's login flow when
                            it reports you aren't signed in
  -q, --quiet               Don't stream agent output
      --json                Print the result as JSON on stdout
  -h, --help                Show this help

Agent command defaults to: ${DEFAULT_AGENT_COMMAND.join(' ')}

Examples:
  acp-launch --agent Planner -p "Plan the upgrade"
  acp-launch -m claude-opus-5.5 -c mode=plan -f prompt.md
  acp-launch --list
  acp-launch -p "hi" -- my-agent --acp`;

function fail(message: string): never {
  console.error(`acp-launch: ${message}`);
  process.exit(1);
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        prompt: { type: 'string', short: 'p' },
        'prompt-file': { type: 'string', short: 'f' },
        config: { type: 'string', short: 'c', multiple: true, default: [] },
        model: { type: 'string', short: 'm' },
        mode: { type: 'string' },
        agent: { type: 'string', short: 'a' },
        'disable-mcp': { type: 'string', multiple: true, default: [] },
        cwd: { type: 'string', short: 'C' },
        permissions: { type: 'string', default: 'deny' },
        list: { type: 'boolean', default: false },
        'no-login': { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }
}

const { values: o, positionals } = parse();
if (o.help) {
  console.log(HELP);
  process.exit(0);
}

const isOneOf = <T extends string>(value: string, allowed: readonly T[]): value is T => (allowed as readonly string[]).includes(value);
if (!isOneOf(o.permissions, ['deny', 'allow', 'allow-always'] as const satisfies readonly PermissionPolicy[])) {
  fail('--permissions must be deny, allow, or allow-always');
}

const command = positionals.length > 0 ? positionals : [...DEFAULT_AGENT_COMMAND];
for (const name of o['disable-mcp']) command.push('--disable-mcp-server', name);

const config = o.config.map((pair): [string, string] => {
  const eq = pair.indexOf('=');
  if (eq <= 0) fail(`--config expects key=value, got "${pair}"`);
  return [pair.slice(0, eq), pair.slice(eq + 1)];
});
if (o.mode) config.push(['mode', o.mode]);
if (o.model) config.push(['model', o.model]);
if (o.agent) config.push(['agent', o.agent]);

function readPrompt() {
  const file = o['prompt-file'];
  if (file === undefined) return o.prompt;
  if (o.prompt !== undefined) fail('use either --prompt or --prompt-file, not both');
  try {
    return readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (err) {
    fail(`could not read prompt file: ${(err as Error).message}`);
  }
}
const prompt = readPrompt();
if (prompt !== undefined && !prompt.trim()) fail('prompt is empty');

let midLine = false;
const log = (msg: string) => {
  if (o.json) return;
  if (midLine) process.stdout.write('\n');
  midLine = false;
  console.error(`\x1b[2m${msg}\x1b[0m`);
};

function onEvent(event: LaunchEvent) {
  switch (event.type) {
    case 'status':
      return log(event.message);
    case 'session':
      return log(`Session ${event.sessionId}`);
    case 'device-code':
      return console.error(`\nSign in to continue: enter \x1b[1m${event.code}\x1b[0m at ${event.url}${event.copied ? ' (copied to clipboard)' : ''}\n`);
    case 'permission': {
      const decision = event.outcome.outcome === 'selected' ? event.outcome.optionId : 'cancelled';
      return log(`Permission ${decision}: ${event.toolCall.title ?? 'tool call'}`);
    }
    case 'update': {
      if (o.quiet || o.json) return;
      const update = event.notification.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        process.stdout.write(update.content.text);
        midLine = !update.content.text.endsWith('\n');
      } else if (update.sessionUpdate === 'tool_call') {
        log(`• ${update.title}`);
      }
    }
  }
}

try {
  const result = await launch({
    command,
    cwd: o.cwd,
    config,
    prompt,
    permissions: o.permissions,
    listOnly: o.list,
    login: !o['no-login'],
    onEvent,
  });
  if (midLine) process.stdout.write('\n');

  if (o.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.settings) {
    for (const s of result.settings) {
      console.log(`${s.id}${s.name !== s.id ? ` (${s.name})` : ''}  current: ${s.current}`);
      for (const v of s.values) console.log(`    ${v.id}${v.name !== v.id ? `  — ${v.name}` : ''}`);
    }
    if (result.settings.length === 0) console.log('(agent exposes no session settings)');
  } else {
    console.log(result.sessionId);
  }
  process.exit(0);
} catch (err) {
  if (midLine) process.stdout.write('\n');
  fail((err as Error).message);
}
