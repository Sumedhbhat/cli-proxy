import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Floor for the reported Claude Code version, used when the local CLI cannot be queried.
export const fallbackClaudeVersion = '2.1.310';
const ttlMs = 3600000; // Claude Code auto-updates, so a long-running gateway re-checks hourly.
const cache = new Map();

const parts = version => version.split('.').map(Number);
const newer = (a, b) => { const [x, y] = [parts(a), parts(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b; return a; };

export const defaultClaudeBinary = () => process.env.CLI_PROXY_CLAUDE_BINARY || join(homedir(), '.local/bin/claude');

export function claudeVersion(binary = defaultClaudeBinary()) {
  const hit = cache.get(binary);
  if (hit && Date.now() - hit.at < ttlMs) return hit.version;
  const version = new Promise(resolve => execFile(binary, ['--version'], { timeout: 10000 }, (error, stdout) => {
    const found = !error && /^(\d+\.\d+\.\d+)\b/.exec(stdout.trim())?.[1];
    resolve(found ? newer(found, fallbackClaudeVersion) : fallbackClaudeVersion);
  }));
  cache.set(binary, { at: Date.now(), version });
  return version;
}

export const claudeUserAgent = async binary => `claude-cli/${await claudeVersion(binary)} (external, cli)`;
