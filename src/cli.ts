#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { launch, COPILOT_COMMAND, DEFAULT_AGENT_COMMAND, type LaunchEvent, type PermissionPolicy } from './launch.js';
import { listMcpServers } from './mcp.js';

const collect = (value: string, previous: string[] = []) => [...previous, value];

function parseConfigPair(pair: string, previous: Array<[string, string]> = []): Array<[string, string]> {
  const eq = pair.indexOf('=');
  if (eq <= 0) throw new InvalidArgumentError('expected key=value');
  return [...previous, [pair.slice(0, eq), pair.slice(eq + 1)]];
}

const program = new Command('acp-launch')
  .description('Start an ACP session, configure it, optionally run a first prompt, then open the session in the GitHub Copilot desktop app.')
  .usage('[options] [-- <agent command...>]')
  .argument('[agent-command...]', `agent to run over ACP (default: ${DEFAULT_AGENT_COMMAND.join(' ')})`)
  .option('-p, --prompt <text>', 'first prompt to send')
  .addOption(new Option('-f, --prompt-file <path>', 'read the first prompt from a file ("-" reads stdin)').conflicts('prompt'))
  .option('-c, --config <key=value>', "set a session config option (repeatable); keys match an option's id, name, or category", parseConfigPair)
  .option('-a, --agent <name>', 'shorthand for --config agent=<name>')
  .option('-m, --model <id>', 'shorthand for --config model=<id>')
  .option('--mode <id>', 'shorthand for --config mode=<id>')
  .option('--disable-mcp <name>', "don't start this MCP server in the ACP session (repeatable), e.g. workiq", collect)
  .option('--no-mcp', "don't start any MCP servers in the ACP session (overrides --disable-mcp); the app uses its own when it resumes")
  .option('--plan-first', 'run the prompt in plan mode, then switch back to the previous mode before opening the app')
  .option('-C, --cwd <dir>', 'session working directory (default: current directory)')
  .addOption(
    new Option('--permissions <mode>', 'how to answer tool permission requests during the prompt')
      .choices(['deny', 'allow', 'allow-always'] satisfies PermissionPolicy[])
      .default('deny'),
  )
  .option('--list', 'create a session and print the settings it exposes')
  .option('--no-login', "fail instead of running the agent's login flow when you aren't signed in")
  .option('-q, --quiet', "don't stream agent output")
  .option('--json', 'print the result as JSON on stdout')
  .addHelpText(
    'after',
    `
Examples:
  acp-launch --agent Planner -p "Plan the upgrade"
  acp-launch -m claude-opus-5.5 -c mode=plan -f prompt.md
  acp-launch --agent Planner --plan-first --no-mcp -f prompt.md
  acp-launch --disable-mcp workiq -f prompt.md
  acp-launch --list
  acp-launch -p "hi" -- my-agent --acp`,
  )
  .showHelpAfterError()
  .parse();

const o = program.opts<{
  prompt?: string;
  promptFile?: string;
  config?: Array<[string, string]>;
  agent?: string;
  model?: string;
  mode?: string;
  disableMcp?: string[];
  mcp: boolean;
  planFirst?: boolean;
  cwd?: string;
  permissions: PermissionPolicy;
  list?: boolean;
  login: boolean;
  quiet?: boolean;
  json?: boolean;
}>();

const command = program.args.length > 0 ? program.args : [...DEFAULT_AGENT_COMMAND];
if (o.mcp) {
  for (const name of o.disableMcp ?? []) command.push('--disable-mcp-server', name);
} else {
  // Disable every configured server by name, and the built-in ones with Copilot's own switch.
  try {
    const servers = await listMcpServers(COPILOT_COMMAND, path.resolve(o.cwd ?? '.'));
    for (const { name, source } of servers) if (source !== 'builtin') command.push('--disable-mcp-server', name);
    command.push('--disable-builtin-mcps');
  } catch (err) {
    program.error(`error: --no-mcp: ${(err as Error).message}`);
  }
}

const config = [...(o.config ?? [])];
if (o.mode) config.push(['mode', o.mode]);
if (o.model) config.push(['model', o.model]);
if (o.agent) config.push(['agent', o.agent]);

function readPrompt() {
  if (o.promptFile === undefined) return o.prompt;
  try {
    return readFileSync(o.promptFile === '-' ? 0 : o.promptFile, 'utf8');
  } catch (err) {
    program.error(`error: could not read prompt file: ${(err as Error).message}`);
  }
}
const prompt = readPrompt();
if (prompt !== undefined && !prompt.trim()) program.error('error: prompt is empty');
if (o.planFirst && prompt === undefined) program.error('error: --plan-first needs --prompt or --prompt-file');

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
    planFirst: o.planFirst,
    login: o.login,
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
  console.error(`acp-launch: ${(err as Error).message}`);
  process.exit(1);
}
