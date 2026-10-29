import { spawn } from 'node:child_process';

/** Open a URL (including custom schemes like ghapp://) with the OS default handler. */
export function openUrl(url: string): Promise<void> {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? // Unlike `cmd /c start`, this doesn't reinterpret `&` or quotes in the URL.
          ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', reject);
    // rundll32's exit code doesn't reflect whether the URL opened, so only trust it elsewhere.
    child.on('exit', (code) =>
      code === 0 || process.platform === 'win32' ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
    );
  });
}
