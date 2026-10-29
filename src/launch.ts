import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { copyToClipboard, parseDeviceCode } from './device-code.js';
import { openUrl } from './open-url.js';
import { spawnCommand } from './spawn.js';
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ActiveSession,
  type AuthMethod,
  type ClientContext,
  type PermissionOption,
  type RequestPermissionOutcome,
  type SessionConfigOption,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type StopReason,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const COPILOT_COMMAND = ['npx', '-y', '@github/copilot'];
export const DEFAULT_AGENT_COMMAND = [...COPILOT_COMMAND, '--acp'];
export { openUrl };

export type PermissionPolicy = 'deny' | 'allow' | 'allow-always';

export type LaunchEvent =
  | { type: 'status'; message: string }
  | { type: 'session'; sessionId: string }
  | { type: 'update'; notification: SessionNotification }
  | { type: 'permission'; toolCall: ToolCallUpdate; outcome: RequestPermissionOutcome }
  | { type: 'device-code'; url: string; code: string; copied: boolean };

export interface LaunchOptions {
  /** Agent command and args. Defaults to `npx -y @github/copilot --acp`. */
  command?: string[];
  /** Session working directory. */
  cwd?: string;
  /** Settings to apply, as `[key, value]` pairs. Keys match id, name, or category. */
  config?: Array<[string, string]>;
  /** First prompt to send. */
  prompt?: string;
  /** How to answer tool permission requests. */
  permissions?: PermissionPolicy;
  /** Only create the session and return the settings it exposes. */
  listOnly?: boolean;
  /** Run the prompt in plan mode, then switch back to the previous mode before handing off to the app. */
  planFirst?: boolean;
  /** Run the agent's login flow if it reports the user isn't authenticated. Defaults to true. */
  login?: boolean;
  onEvent?: (event: LaunchEvent) => void;
}

export interface Setting {
  kind: 'config' | 'mode';
  id: string;
  name: string;
  category?: string | null;
  current: string | boolean;
  values: Array<{ id: string; name: string }>;
}

export interface LaunchResult {
  sessionId: string;
  url?: string;
  stopReason?: StopReason;
  settings?: Setting[];
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

function describeConfigOption(option: SessionConfigOption): Setting {
  const values =
    option.type === 'boolean'
      ? [
          { id: 'true', name: 'On' },
          { id: 'false', name: 'Off' },
        ]
      : option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry])).map((o) => ({ id: o.value, name: o.name }));
  return { kind: 'config', id: option.id, name: option.name, category: option.category, current: option.currentValue, values };
}

/** Normalize everything the agent advertised into one list of settable keys. */
export function describeSettings(configOptions: SessionConfigOption[] | null | undefined, modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> } | null): Setting[] {
  const settings = (configOptions ?? []).map(describeConfigOption);
  if (modes && !settings.some((s) => s.id === 'mode' || s.category === 'mode')) {
    settings.push({
      kind: 'mode',
      id: 'mode',
      name: 'Mode',
      current: modes.currentModeId,
      values: modes.availableModes.map((m) => ({ id: m.id, name: m.name })),
    });
  }
  return settings;
}

function findSetting(settings: Setting[], key: string) {
  const k = norm(key);
  return (
    settings.find((s) => norm(s.id) === k) ?? settings.find((s) => norm(s.name) === k) ?? settings.find((s) => norm(s.category) === k)
  );
}

function resolveSetting(settings: Setting[], key: string, value: string) {
  const setting = findSetting(settings, key);
  if (!setting) {
    throw new Error(`Agent does not expose a "${key}" setting. Available: ${settings.map((s) => s.id).join(', ') || '(none)'}`);
  }
  const v = norm(value);
  const match = setting.values.find((o) => norm(o.id) === v) ?? setting.values.find((o) => norm(o.name) === v);
  if (!match) {
    throw new Error(`"${value}" is not a valid value for ${setting.id}. Available: ${setting.values.map((o) => o.id).join(', ')}`);
  }
  return { setting, value: match.id };
}

/** Deep link that opens (resumes) a session in the GitHub Copilot desktop app. */
export function sessionUrl(sessionId: string) {
  return `ghapp://sessions/${encodeURIComponent(sessionId)}`;
}

function pickPermission(options: PermissionOption[], policy: PermissionPolicy): RequestPermissionOutcome {
  const order: Array<PermissionOption['kind']> =
    policy === 'allow' ? ['allow_once', 'allow_always'] : policy === 'allow-always' ? ['allow_always', 'allow_once'] : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: 'selected', optionId: option.optionId };
  }
  return { outcome: 'cancelled' };
}

/** Create an ACP session, apply config, optionally run a first prompt, and open the desktop app on it. */
export async function launch(opts: LaunchOptions = {}): Promise<LaunchResult> {
  try {
    return await runOnce(opts, opts.login ?? true);
  } catch (err) {
    if (!(err instanceof RetryAfterLogin)) throw err;
    return runOnce(opts, false);
  }
}

class RetryAfterLogin extends Error {}

async function runOnce(opts: LaunchOptions, allowLogin: boolean): Promise<LaunchResult> {
  const {
    command = DEFAULT_AGENT_COMMAND,
    cwd = process.cwd(),
    config = [],
    prompt,
    permissions = 'deny',
    listOnly = false,
    planFirst = false,
    onEvent = () => {},
  } = opts;
  const [bin, ...args] = command;
  if (!bin) throw new Error('Agent command is empty');

  const sessionCwd = path.resolve(cwd);
  onEvent({ type: 'status', message: `Starting ${command.join(' ')}` });
  const proc = spawnCommand(bin, args, { cwd: sessionCwd, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    proc.once('spawn', resolve);
    proc.once('error', (err) => reject(new Error(`Failed to start agent \`${bin}\`: ${err.message}`)));
  });
  const stream = ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>);

  const app = client({ name: '@cmdforge/acp-launch' })
    .onRequest('session/request_permission', ({ params }) => {
      const outcome = pickPermission(params.options, permissions);
      onEvent({ type: 'permission', toolCall: params.toolCall, outcome });
      return { outcome };
    })
    .onRequest('elicitation/create', async ({ params }) => {
      // URL elicitations (e.g. OAuth) are completed in the browser; we can't render forms.
      if (params.mode !== 'url' || !('url' in params) || typeof params.url !== 'string') return { action: 'decline' };
      onEvent({ type: 'status', message: `${params.message}\nOpening ${params.url}` });
      await openUrl(params.url);
      return { action: 'accept' };
    });

  let cancel: (() => void) | undefined;
  const onSigint = () => (cancel ? cancel() : proc.kill('SIGINT'));
  process.on('SIGINT', onSigint);

  try {
    const result = await app.connectWith(stream, async (agent) => {
      const init = await agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: true },
          elicitation: { url: {} },
        },
        clientInfo: { name: '@cmdforge/acp-launch', version: VERSION },
      });

      let session: ActiveSession;
      try {
        session = await agent.buildSession(sessionCwd).start();
      } catch (err) {
        if (!allowLogin || !isAuthError(err)) throw err;
        await login(agent, init.authMethods ?? [], command, sessionCwd, onEvent);
        throw new RetryAfterLogin();
      }
      const { sessionId } = session;
      onEvent({ type: 'session', sessionId });
      try {
        let settings = describeSettings(session.newSessionResponse.configOptions, session.modes);
        if (listOnly) return { sessionId, settings };

        const apply = async (key: string, raw: string) => {
          const { setting, value } = resolveSetting(settings, key, raw);
          if (setting.kind === 'mode') {
            await agent.request('session/set_mode', { sessionId, modeId: value });
            setting.current = value;
          } else {
            const request: SetSessionConfigOptionRequest =
              typeof setting.current === 'boolean'
                ? { sessionId, configId: setting.id, type: 'boolean', value: value === 'true' }
                : { sessionId, configId: setting.id, value };
            const response = await agent.request('session/set_config_option', request);
            settings = describeSettings(response.configOptions, session.modes);
          }
          onEvent({ type: 'status', message: `Set ${setting.id} = ${value}` });
        };
        for (const [key, raw] of config) await apply(key, raw);

        // Plan first: run the prompt in plan mode so nothing changes before the user sees it,
        // then put the session back in its previous mode so the app resumes ready to implement.
        let restoreMode: string | undefined;
        if (planFirst && prompt) {
          restoreMode = String(resolveSetting(settings, 'mode', 'plan').setting.current);
          await apply('mode', 'plan');
        }

        let stopReason: StopReason | undefined;
        if (prompt) {
          onEvent({ type: 'status', message: 'Sending prompt…' });
          cancel = () => {
            onEvent({ type: 'status', message: 'Cancelling turn…' });
            void agent.notify('session/cancel', { sessionId });
          };
          void session.prompt(prompt).catch(() => {}); // errors surface through nextUpdate()
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === 'stop') {
              stopReason = message.stopReason;
              break;
            }
            onEvent({ type: 'update', notification: message.notification });
          }
          cancel = undefined;
          onEvent({ type: 'status', message: `Turn finished: ${stopReason}` });
        }
        if (restoreMode !== undefined) await apply('mode', restoreMode);

        // Release the session so the desktop app can take it over with everything flushed to disk.
        if (init.agentCapabilities?.sessionCapabilities?.close) {
          await agent.request('session/close', { sessionId }).catch(() => {});
        }
        return { sessionId, url: sessionUrl(sessionId), stopReason };
      } finally {
        session.dispose();
      }
    });

    await shutdown(proc, exited);
    if (result.url) {
      onEvent({ type: 'status', message: `Opening ${result.url}` });
      await openUrl(result.url);
    }
    return result;
  } catch (err) {
    if (isAuthError(err) && !(err instanceof RetryAfterLogin)) {
      (err as Error).message +=
        opts.login === false
          ? '\nThe agent reports you are not signed in, and login is disabled.'
          : '\nStill not authorized after login. Make sure the account you signed in with has access.';
    }
    throw err;
  } finally {
    process.off('SIGINT', onSigint);
    await shutdown(proc, exited);
  }
}

/** Copilot reports "not logged in" as a 403 instead of ACP's auth_required (-32000). */
function isAuthError(err: unknown) {
  if (!(err instanceof RequestError)) return false;
  const status = (err.data as { status?: number } | undefined)?.status;
  return err.code === -32000 || status === 401 || status === 403;
}

/** Command line for a terminal auth method: typed `terminal` methods or the legacy `_meta["terminal-auth"]` form. */
function terminalAuthCommand(method: AuthMethod, agentCommand: string[]) {
  if ('type' in method && method.type === 'terminal') {
    return { command: [...agentCommand, ...(method.args ?? [])], env: method.env ?? {} };
  }
  const legacy = method._meta?.['terminal-auth'] as { command?: string; args?: string[]; env?: Record<string, string> } | undefined;
  if (legacy?.command) return { command: [legacy.command, ...(legacy.args ?? [])], env: legacy.env ?? {} };
  return undefined;
}

async function login(agent: ClientContext, methods: AuthMethod[], agentCommand: string[], cwd: string, onEvent: (event: LaunchEvent) => void) {
  const method = methods[0];
  if (!method) throw new Error('The agent requires login but advertises no auth methods');

  const terminal = terminalAuthCommand(method, agentCommand);
  onEvent({ type: 'status', message: `Not logged in. Running "${method.name}"…` });
  if (!terminal) {
    // Agent-handled login: the agent drives it, possibly via elicitation/create.
    await agent.request('authenticate', { methodId: method.id });
    return;
  }

  const [bin, ...args] = terminal.command;
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawnCommand(bin!, args, {
      cwd,
      env: { ...process.env, ...terminal.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Mirror output, and copy any device code so it's ready to paste into the page the login opens.
    let output = '';
    let presented = false;
    const scan = (chunk: Buffer) => {
      process.stderr.write(chunk);
      output += chunk.toString();
      const deviceCode = presented ? undefined : parseDeviceCode(output);
      if (deviceCode) {
        presented = true;
        void copyToClipboard(deviceCode.code).then((copied) => onEvent({ type: 'device-code', ...deviceCode, copied }));
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) throw new Error(`Login failed: ${terminal.command.join(' ')} exited with code ${code}`);
}

async function shutdown(proc: ReturnType<typeof spawn>, exited: Promise<void>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.stdin?.end();
  const timer = setTimeout(() => proc.kill('SIGTERM'), 3000);
  await exited;
  clearTimeout(timer);
}
