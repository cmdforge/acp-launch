#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { launch, DEFAULT_AGENT_COMMAND, DEFAULT_URL_TEMPLATE } from '../src/launch.js';

const HELP = `Usage: acp-launch [options] [-- <agent command...>]

Start an ACP session, configure it, optionally run a first prompt, then open
the desktop app on that session.

Options:
  -p, --prompt <text>       First prompt to send ("-" reads stdin)
  -c, --config <key=value>  Set a session config option (repeatable). Keys match an
                            option's id, name, or category; values match id or name.
  -m, --model <id>          Shorthand for --config model=<id>
      --mode <id>           Shorthand for --config mode=<id>
  -a, --agent <name>        Custom agent to load. With the default Copilot command this
                            is passed as \`copilot --agent <name>\`; otherwise it is
                            treated as --config agent=<name>
  -C, --cwd <dir>           Session working directory (default: current directory)
      --open <when>         after (default): open app once the prompt turn finishes
                            before: open app first, then run the prompt
                            never: don't open the app
      --url <template>      Deep link template (default: ${DEFAULT_URL_TEMPLATE})
      --permissions <mode>  Answer tool permission requests during the prompt with
                            deny (default), allow, or allow-always
      --list                Create a session and print the settings it exposes
  -q, --quiet               Don't stream agent output
      --json                Print the result as JSON on stdout
  -h, --help                Show this help

Agent command defaults to: ${DEFAULT_AGENT_COMMAND.join(' ')}

Examples:
  acp-launch --agent reviewer -p "Review the open changes"
  acp-launch -m gpt-5 -c mode=plan --open before -p "Plan a refactor of src/"
  acp-launch --list
  acp-launch -p "hi" -- my-agent --acp`;

function fail(message) {
  console.error(`acp-launch: ${message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      prompt: { type: 'string', short: 'p' },
      config: { type: 'string', short: 'c', multiple: true, default: [] },
      model: { type: 'string', short: 'm' },
      mode: { type: 'string' },
      agent: { type: 'string', short: 'a' },
      cwd: { type: 'string', short: 'C' },
      open: { type: 'string', default: 'after' },
      url: { type: 'string', default: DEFAULT_URL_TEMPLATE },
      permissions: { type: 'string', default: 'deny' },
      list: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (err) {
  fail(err.message);
}

const { values: o, positionals } = parsed;
if (o.help) {
  console.log(HELP);
  process.exit(0);
}
if (!['after', 'before', 'never'].includes(o.open)) fail(`--open must be after, before, or never`);
if (!['deny', 'allow', 'allow-always'].includes(o.permissions)) fail(`--permissions must be deny, allow, or allow-always`);

const customCommand = positionals.length > 0;
const command = customCommand ? positionals : [...DEFAULT_AGENT_COMMAND];

const config = o.config.map((pair) => {
  const eq = pair.indexOf('=');
  if (eq <= 0) fail(`--config expects key=value, got "${pair}"`);
  return [pair.slice(0, eq), pair.slice(eq + 1)];
});
if (o.mode) config.push(['mode', o.mode]);
if (o.model) config.push(['model', o.model]);
if (o.agent) {
  if (customCommand) config.push(['agent', o.agent]);
  else command.push('--agent', o.agent);
}

let prompt = o.prompt;
if (prompt === '-') prompt = readFileSync(0, 'utf8');

let midLine = false;
const log = (msg) => {
  if (o.json) return;
  if (midLine) process.stdout.write('\n');
  midLine = false;
  console.error(`\x1b[2m${msg}\x1b[0m`);
};

function onEvent(event) {
  if (event.type === 'status') return log(event.message);
  if (event.type === 'session') return log(`Session ${event.sessionId}`);
  if (event.type === 'permission') {
    const title = event.toolCall?.title ?? 'tool call';
    return log(`Permission ${event.outcome.outcome === 'selected' ? event.outcome.optionId : 'cancelled'}: ${title}`);
  }
  if (event.type !== 'update' || o.quiet || o.json) return;
  const update = event.update;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    process.stdout.write(update.content.text);
    midLine = !update.content.text.endsWith('\n');
  } else if (update.sessionUpdate === 'tool_call') {
    log(`• ${update.title ?? update.kind ?? 'tool'}`);
  }
}

try {
  const result = await launch({
    command,
    cwd: o.cwd,
    config,
    prompt,
    open: o.open,
    urlTemplate: o.url,
    permissions: o.permissions,
    listOnly: o.list,
    onEvent,
  });
  if (midLine) process.stdout.write('\n');

  if (o.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (o.list) {
    for (const s of result.settings) {
      console.log(`${s.id}${s.name && s.name !== s.id ? ` (${s.name})` : ''}  current: ${s.current}`);
      for (const v of s.values) console.log(`    ${v.id}${v.name && v.name !== v.id ? `  — ${v.name}` : ''}`);
    }
    if (result.settings.length === 0) console.log('(agent exposes no session settings)');
  } else {
    console.log(result.sessionId);
  }
  process.exit(0);
} catch (err) {
  if (midLine) process.stdout.write('\n');
  fail(err.message);
}
