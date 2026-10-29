import { spawnCommand } from './spawn.js';

export interface McpServer {
  name: string;
  /** Where the server is configured: user, workspace, plugin, or builtin. */
  source: string;
}

/** Ask Copilot for every MCP server it would start in `cwd` (`copilot mcp list --json`). */
export function listMcpServers(copilotCommand: string[], cwd: string): Promise<McpServer[]> {
  const [bin, ...args] = copilotCommand;
  return new Promise((resolve, reject) => {
    const child = spawnCommand(bin!, [...args, 'mcp', 'list', '--json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`copilot mcp list failed (exit ${code}): ${stderr.trim()}`));
      try {
        const { mcpServers = {} } = JSON.parse(stdout) as { mcpServers?: Record<string, { source?: string }> };
        resolve(Object.entries(mcpServers).map(([name, server]) => ({ name, source: server.source ?? 'unknown' })));
      } catch {
        reject(new Error(`could not parse copilot mcp list output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}
