import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type PermissionOption,
  type RequestPermissionOutcome,
  type SessionConfigOption,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type StopReason,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';

export const DEFAULT_AGENT_COMMAND = ['npx', '-y', '@github/copilot', '--acp'];
export const DEFAULT_URL_TEMPLATE = 'ghapp://sessions/{id}';

export type OpenTiming = 'after' | 'before' | 'never';
export type PermissionPolicy = 'deny' | 'allow' | 'allow-always';

export type LaunchEvent =
  | { type: 'status'; message: string }
  | { type: 'session'; sessionId: string }
  | { type: 'update'; notification: SessionNotification }
  | { type: 'permission'; toolCall: ToolCallUpdate; outcome: RequestPermissionOutcome };

export interface LaunchOptions {
  /** Agent command and args. Defaults to `npx -y @github/copilot --acp`. */
  command?: string[];
  /** Session working directory. */
  cwd?: string;
  /** Settings to apply, as `[key, value]` pairs. Keys match id, name, or category. */
  config?: Array<[string, string]>;
  /** First prompt to send. */
  prompt?: string;
  /** When to open the app relative to the prompt turn. */
  open?: OpenTiming;
  /** Deep link template; `{id}` is replaced with the session id. */
  urlTemplate?: string;
  /** How to answer tool permission requests. */
  permissions?: PermissionPolicy;
  /** Only create the session and return the settings it exposes. */
  listOnly?: boolean;
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

export function sessionUrl(template: string, sessionId: string) {
  return template.replaceAll('{id}', encodeURIComponent(sessionId));
}

export function openUrl(url: string): Promise<void> {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
    child.unref();
  });
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
  const {
    command = DEFAULT_AGENT_COMMAND,
    cwd = process.cwd(),
    config = [],
    prompt,
    open = 'after',
    urlTemplate = DEFAULT_URL_TEMPLATE,
    permissions = 'deny',
    listOnly = false,
    onEvent = () => {},
  } = opts;
  const [bin, ...args] = command;
  if (!bin) throw new Error('Agent command is empty');

  const sessionCwd = path.resolve(cwd);
  onEvent({ type: 'status', message: `Starting ${command.join(' ')}` });
  const proc = spawn(bin, args, { cwd: sessionCwd, stdio: ['pipe', 'pipe', 'inherit'], shell: process.platform === 'win32' });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    proc.once('spawn', resolve);
    proc.once('error', (err) => reject(new Error(`Failed to start agent \`${bin}\`: ${err.message}`)));
  });
  const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>);

  const app = client({ name: '@cmdforge/acp-launch' }).onRequest('session/request_permission', ({ params }) => {
    const outcome = pickPermission(params.options, permissions);
    onEvent({ type: 'permission', toolCall: params.toolCall, outcome });
    return { outcome };
  });

  let cancel: (() => void) | undefined;
  const onSigint = () => (cancel ? cancel() : proc.kill('SIGINT'));
  process.on('SIGINT', onSigint);

  try {
    const result = await app.connectWith(stream, async (agent) => {
      const init = await agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: '@cmdforge/acp-launch', version: '0.1.0' },
      });

      const session = await agent.buildSession(sessionCwd).start();
      const { sessionId } = session;
      onEvent({ type: 'session', sessionId });

      try {
        let settings = describeSettings(session.newSessionResponse.configOptions, session.modes);
        if (listOnly) return { sessionId, settings };

        for (const [key, raw] of config) {
          const { setting, value } = resolveSetting(settings, key, raw);
          if (setting.kind === 'mode') {
            await agent.request('session/set_mode', { sessionId, modeId: value });
          } else {
            const request: SetSessionConfigOptionRequest =
              typeof setting.current === 'boolean'
                ? { sessionId, configId: setting.id, type: 'boolean', value: value === 'true' }
                : { sessionId, configId: setting.id, value };
            const response = await agent.request('session/set_config_option', request);
            settings = describeSettings(response.configOptions, session.modes);
          }
          onEvent({ type: 'status', message: `Set ${setting.id} = ${value}` });
        }

        const url = sessionUrl(urlTemplate, sessionId);
        if (open === 'before') {
          onEvent({ type: 'status', message: `Opening ${url}` });
          await openUrl(url);
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

        // Release the session so the desktop app can take it over with everything flushed to disk.
        if (init.agentCapabilities?.sessionCapabilities?.close) {
          await agent.request('session/close', { sessionId }).catch(() => {});
        }
        return { sessionId, url, stopReason };
      } finally {
        session.dispose();
      }
    });

    await shutdown(proc, exited);
    if (open === 'after' && result.url) {
      onEvent({ type: 'status', message: `Opening ${result.url}` });
      await openUrl(result.url);
    }
    return result;
  } catch (err) {
    if (err instanceof RequestError && (err.data as { status?: number } | undefined)?.status === 403) {
      err.message += '\nThe agent is not authorized. For Copilot, run `npx -y @github/copilot login` and try again.';
    }
    throw err;
  } finally {
    process.off('SIGINT', onSigint);
    await shutdown(proc, exited);
  }
}

async function shutdown(proc: ReturnType<typeof spawn>, exited: Promise<void>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.stdin?.end();
  const timer = setTimeout(() => proc.kill('SIGTERM'), 3000);
  await exited;
  clearTimeout(timer);
}
