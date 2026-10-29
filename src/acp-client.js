import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class AcpError extends Error {
  constructor(method, error) {
    super(`${method} failed: ${error?.message ?? 'unknown error'}`);
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
  }
}

/**
 * Minimal ACP (Agent Client Protocol) client over newline-delimited JSON-RPC on stdio.
 * Emits 'update' for session/update notifications and 'exit' when the agent process ends.
 */
export class AcpClient extends EventEmitter {
  #proc;
  #nextId = 0;
  #pending = new Map();
  #buffer = '';
  #handlers = new Map();

  constructor(command, args, { cwd, env, stderr = 'inherit' } = {}) {
    super();
    this.#proc = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', stderr],
      shell: process.platform === 'win32',
    });
    this.#proc.stdout.setEncoding('utf8');
    this.#proc.stdout.on('data', (chunk) => this.#onData(chunk));
    this.#proc.on('error', (err) => this.#failAll(err));
    this.#proc.on('exit', (code, signal) => {
      this.#failAll(new Error(`agent process exited (code ${code}${signal ? `, signal ${signal}` : ''})`));
      this.emit('exit', code, signal);
    });
  }

  /** Register a handler for agent -> client requests (e.g. session/request_permission). */
  handle(method, fn) {
    this.#handlers.set(method, fn);
  }

  request(method, params) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  async close() {
    if (this.#proc.exitCode !== null || this.#proc.signalCode !== null) return;
    const exited = new Promise((resolve) => this.#proc.once('exit', resolve));
    this.#proc.stdin.end();
    const timer = setTimeout(() => this.#proc.kill('SIGTERM'), 3000);
    await exited;
    clearTimeout(timer);
  }

  #send(message) {
    if (!this.#proc.stdin.writable) throw new Error('agent process is not running');
    this.#proc.stdin.write(JSON.stringify(message) + '\n');
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit('stray', line);
        continue;
      }
      this.#dispatch(message);
    }
  }

  async #dispatch(message) {
    // Response to one of our requests
    if (message.id != null && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new AcpError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    // Notification from the agent
    if (message.id == null) {
      if (message.method === 'session/update') this.emit('update', message.params);
      else this.emit('notification', message);
      return;
    }
    // Request from the agent
    const handler = this.#handlers.get(message.method);
    if (!handler) {
      this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    try {
      const result = await handler(message.params);
      this.#send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
    } catch (err) {
      this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  }

  #failAll(err) {
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }
}
