import { spawn } from 'node:child_process';
import { openUrl } from './open-url.js';

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

/** Run a helper command; `code` is null if it couldn't be started or was aborted. */
function run(cmd: string, args: string[], input?: string, signal?: AbortSignal) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], signal });
    let stdout = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.on('error', () => resolve({ code: null, stdout }));
    child.on('exit', (code) => resolve({ code, stdout }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

export async function copyToClipboard(text: string) {
  if (process.platform === 'darwin') await run('pbcopy', [], text);
  else if (process.platform === 'win32') await run('clip', [], text);
  else if ((await run('wl-copy', [text])).code !== 0) await run('xclip', ['-selection', 'clipboard'], text);
}

/**
 * Show the device code somewhere visible even when nobody is watching our stdout:
 * copy it, then show a native dialog whose button opens the verification page.
 * Falls back to opening the page directly when no dialog is available.
 * Aborting `signal` (e.g. once login completes) closes the dialog.
 */
export async function presentDeviceCode({ url, code }: DeviceCode, signal?: AbortSignal) {
  await copyToClipboard(code);
  const message = `Enter this code on GitHub to sign in to Copilot:\n\n${code}\n\nIt has been copied to your clipboard. Use a browser signed in to the account you want.`;
  if (process.platform === 'darwin') {
    const script = `display dialog ${JSON.stringify(message)} with title "acp-launch" buttons {"Cancel", "Open GitHub"} default button "Open GitHub" giving up after 900`;
    const result = await run('osascript', ['-e', script], undefined, signal);
    if (signal?.aborted) return;
    if (result.code !== null) {
      // Cancel exits non-zero; only the "Open GitHub" button opens the page.
      if (result.stdout.includes('button returned:Open GitHub')) await openUrl(url);
      return;
    }
  }
  await openUrl(url);
}
