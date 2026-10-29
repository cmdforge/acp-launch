import { spawn } from 'node:child_process';
import path from 'node:path';
import { AcpClient, AcpError } from './acp-client.js';

export const DEFAULT_AGENT_COMMAND = ['npx', '-y', '@github/copilot', '--acp'];
export const DEFAULT_URL_TEMPLATE = 'ghapp://sessions/{id}';

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Flatten a select config option's options, which may be a flat list or grouped. */
function flattenOptions(option) {
  const out = [];
  for (const entry of option.options ?? []) {
    if (Array.isArray(entry.options)) out.push(...entry.options);
    else out.push(entry);
  }
  return out;
}

/** Normalize everything the agent advertised into one list of settable keys. */
export function describeSettings(session) {
  const settings = [];
  for (const option of session.configOptions ?? []) {
    settings.push({
      kind: 'config',
      id: option.id,
      name: option.name,
      category: option.category,
      current: option.currentValue,
      values: flattenOptions(option).map((o) => ({ id: o.value, name: o.name })),
    });
  }
  const has = (category) => settings.some((s) => s.id === category || s.category === category);
  if (session.modes && !has('mode')) {
    settings.push({
      kind: 'mode',
      id: 'mode',
      name: 'Mode',
      current: session.modes.currentModeId,
      values: session.modes.availableModes.map((m) => ({ id: m.id, name: m.name })),
    });
  }
  if (session.models && !has('model')) {
    settings.push({
      kind: 'model',
      id: 'model',
      name: 'Model',
      current: session.models.currentModelId,
      values: session.models.availableModels.map((m) => ({ id: m.modelId, name: m.name })),
    });
  }
  return settings;
}

function findSetting(settings, key) {
  const k = norm(key);
  return (
    settings.find((s) => norm(s.id) === k) ??
    settings.find((s) => norm(s.name) === k) ??
    settings.find((s) => norm(s.category) === k)
  );
}

function findValue(setting, value) {
  const v = norm(value);
  return setting.values.find((o) => norm(o.id) === v) ?? setting.values.find((o) => norm(o.name) === v);
}

async function applySetting(client, sessionId, settings, key, value) {
  const setting = findSetting(settings, key);
  if (!setting) {
    const known = settings.map((s) => s.id).join(', ') || '(none)';
    throw new Error(`Agent does not expose a "${key}" setting. Available: ${known}`);
  }
  const match = findValue(setting, value);
  if (!match) {
    const known = setting.values.map((o) => o.id).join(', ');
    throw new Error(`"${value}" is not a valid value for ${setting.id}. Available: ${known}`);
  }
  if (setting.kind === 'config') {
    const result = await client.request('session/set_config_option', { sessionId, configId: setting.id, value: match.id });
    return result?.configOptions;
  }
  if (setting.kind === 'mode') {
    await client.request('session/set_mode', { sessionId, modeId: match.id });
  } else {
    await client.request('session/set_model', { sessionId, modelId: match.id });
  }
  return undefined;
}

export function sessionUrl(template, sessionId) {
  return template.replaceAll('{id}', encodeURIComponent(sessionId));
}

export function openUrl(url) {
  const [cmd, args] =
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

function pickPermission(options, policy) {
  const order =
    policy === 'allow'
      ? ['allow_once', 'allow_always']
      : policy === 'allow-always'
        ? ['allow_always', 'allow_once']
        : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: 'selected', optionId: option.optionId };
  }
  return { outcome: 'cancelled' };
}

/**
 * Create an ACP session, apply config, optionally run a first prompt, and open the desktop app on it.
 *
 * @param {object} opts
 * @param {string[]} [opts.command]       agent command + args (default: npx -y @github/copilot --acp)
 * @param {string} [opts.cwd]             session working directory
 * @param {Array<[string,string]>} [opts.config]  settings to apply, as [key, value] pairs
 * @param {string} [opts.prompt]          first prompt to send
 * @param {'after'|'before'|'never'} [opts.open]  when to open the app relative to the prompt
 * @param {string} [opts.urlTemplate]     deep link template, {id} is replaced with the session id
 * @param {'deny'|'allow'|'allow-always'} [opts.permissions]  how to answer tool permission requests
 * @param {boolean} [opts.listOnly]       only create the session and return the available settings
 * @param {(event: object) => void} [opts.onEvent]  progress callback
 */
export async function launch(opts = {}) {
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

  const sessionCwd = path.resolve(cwd);
  const client = new AcpClient(command[0], command.slice(1), { cwd: sessionCwd });
  client.on('update', (params) => onEvent({ type: 'update', ...params }));
  client.handle('session/request_permission', async (params) => {
    const outcome = pickPermission(params.options ?? [], permissions);
    onEvent({ type: 'permission', toolCall: params.toolCall, outcome });
    return { outcome };
  });

  let sessionId;
  let interrupted = false;
  const onSigint = () => {
    if (sessionId && !interrupted) {
      interrupted = true;
      onEvent({ type: 'status', message: 'Cancelling turn…' });
      client.notify('session/cancel', { sessionId });
    } else {
      client.close().finally(() => process.exit(130));
    }
  };
  process.on('SIGINT', onSigint);

  try {
    onEvent({ type: 'status', message: `Starting ${command.join(' ')}` });
    const init = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: '@cmdforge/acp-launch', version: '0.1.0' },
    });

    const session = await client.request('session/new', { cwd: sessionCwd, mcpServers: [] });
    sessionId = session.sessionId;
    onEvent({ type: 'session', sessionId });

    let settings = describeSettings(session);
    if (listOnly) return { sessionId, settings, agentInfo: init.agentInfo };

    for (const [key, value] of config) {
      const updated = await applySetting(client, sessionId, settings, key, value);
      if (updated) settings = describeSettings({ ...session, configOptions: updated });
      onEvent({ type: 'status', message: `Set ${key} = ${value}` });
    }

    const url = sessionUrl(urlTemplate, sessionId);
    const openApp = async () => {
      onEvent({ type: 'status', message: `Opening ${url}` });
      await openUrl(url);
    };

    if (open === 'before') await openApp();

    let stopReason;
    if (prompt) {
      onEvent({ type: 'status', message: 'Sending prompt…' });
      const result = await client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      stopReason = result?.stopReason;
      onEvent({ type: 'status', message: `Turn finished: ${stopReason}` });
    }

    // Release the session so the desktop app can take it over with everything flushed to disk.
    if (init.agentCapabilities?.sessionCapabilities?.close) {
      await client.request('session/close', { sessionId }).catch(() => {});
    }
    await client.close();

    if (open === 'after') await openApp();
    return { sessionId, url, stopReason };
  } catch (err) {
    if (err instanceof AcpError && err.data?.status === 403) {
      err.message += '\nThe agent is not authorized. For Copilot, run `npx -y @github/copilot login` and try again.';
    }
    throw err;
  } finally {
    process.off('SIGINT', onSigint);
    await client.close().catch(() => {});
  }
}
