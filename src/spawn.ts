import { spawn, type SpawnOptions } from 'node:child_process';

/** Quote an argument for cmd.exe, which is what `shell: true` uses on Windows. */
function quoteForCmd(arg: string) {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

/**
 * Spawn a command the same way on every platform. On Windows, bare commands like `npx`
 * are `.cmd` shims that Node can only start through a shell, so those go through cmd.exe
 * with their arguments quoted; paths to executables are started directly.
 */
export function spawnCommand(command: string, args: string[], options: Omit<SpawnOptions, 'shell'>) {
  const needsShell = process.platform === 'win32' && !/[\\/]/.test(command);
  return needsShell
    ? spawn(quoteForCmd(command), args.map(quoteForCmd), { ...options, shell: true })
    : spawn(command, args, options);
}
