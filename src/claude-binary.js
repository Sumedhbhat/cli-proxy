import { accessSync, readdirSync, statSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const semver = /^\d+\.\d+\.\d+$/;
const parts = version => version.split('.').map(Number);
export const compareVersions = (a, b) => { const [x, y] = [parts(a), parts(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
// X_OK also passes for searchable directories, so require a regular file.
const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };

// Claude Code's native installer keeps each release at `.../claude/versions/<version>` and updates
// by adding a newer file, so a path pinned to one release would freeze Claude Code there.
export function followUpdates(binary) {
  const dir = dirname(binary), current = basename(binary);
  if (basename(dir) !== 'versions' || !semver.test(current)) return binary;
  let names; try { names = readdirSync(dir); } catch { return binary; }
  const newest = names.filter(name => semver.test(name) && compareVersions(name, current) > 0 && executable(join(dir, name))).sort(compareVersions).at(-1);
  return newest ? join(dir, newest) : binary;
}

export const claudeBinary = () => process.env.CLI_PROXY_CLAUDE_BINARY ? followUpdates(process.env.CLI_PROXY_CLAUDE_BINARY) : join(homedir(), '.local/bin/claude');
