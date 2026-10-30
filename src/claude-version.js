import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Floor for the reported Claude Code version, used when the local CLI cannot be queried.
export const fallbackClaudeVersion = '2.1.310';
const ttlMs = 3600000; // Claude Code auto-updates, so a long-running gateway re-checks hourly.
const cache = new Map();

const parts = version => version.split('.').map(Number);
const newer = (a, b) => { const [x, y] = [parts(a), parts(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b; return a; };

// An explicit override wins; otherwise prefer `claude` on PATH, then the native installer location.
export const defaultClaudeBinary = () => process.env.CLI_PROXY_CLAUDE_BINARY || ['claude', join(homedir(), '.local/bin/claude')];

// SIGKILL so a binary that ignores SIGTERM cannot leave the quota refresh pending.
const installedVersion = binary => new Promise(resolve => execFile(binary, ['--version'], { timeout: 10000, killSignal: 'SIGKILL' }, (error, stdout) => {
  resolve(!error && /^(\d+\.\d+\.\d+)\b/.exec(stdout.trim())?.[1]);
}));

export function claudeVersion(binaries = defaultClaudeBinary()) {
  const key = [binaries].flat().join('\0'), hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.version;
  const version = (async () => {
    for (const binary of [binaries].flat()) { const found = await installedVersion(binary); if (found) return newer(found, fallbackClaudeVersion); }
    return fallbackClaudeVersion;
  })();
  cache.set(key, { at: Date.now(), version });
  return version;
}

export const claudeUserAgent = async binary => `claude-cli/${await claudeVersion(binary)} (external, cli)`;
