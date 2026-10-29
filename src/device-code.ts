import { spawn } from 'node:child_process';

export interface DeviceCode {
  url: string;
  code: string;
}

/** Find a device-flow URL and user code (e.g. `ABCD-1234`) in login output. */
export function parseDeviceCode(text: string): DeviceCode | undefined {
  const url = /https?:\/\/\S*\/login\/device\b\S*/.exec(text)?.[0];
  const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(text)?.[0];
  return url && code ? { url, code } : undefined;
}

function pipeTo(cmd: string, args: string[], input: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
    child.stdin?.end(input);
  });
}

/** Best-effort copy to the system clipboard; returns whether it worked. */
export async function copyToClipboard(text: string) {
  if (process.platform === 'darwin') return pipeTo('pbcopy', [], text);
  if (process.platform === 'win32') return pipeTo('clip', [], text);
  return (await pipeTo('wl-copy', [], text)) || pipeTo('xclip', ['-selection', 'clipboard'], text);
}
