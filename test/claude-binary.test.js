import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// T3's Claude provider ran this launcher with CLI_PROXY_CLAUDE_BINARY pointing at one native
// install, `~/.local/share/claude/versions/2.1.310`. Claude Code updates by adding a new file
// next to it (versions/2.1.314) and never rewrites that path, so T3 kept running and showing
// 2.1.310 after every update. A path inside the versions directory must follow updates.
const run = promisify(execFile);
const fake = (path, output) => writeFile(path, `#!/bin/sh\necho "${output}"\n`, { mode: 0o700 });

async function launch(t, setup) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-proxy-claude-binary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = await setup(dir);
  const { stdout } = await run(process.execPath, ['scripts/claude-client.js', '--version'], { env: { ...process.env, CLI_PROXY_CLAUDE_BINARY: binary } });
  return stdout.trim();
}

test('a binary pinned inside the Claude versions directory runs the newest installed version', async t => {
  assert.equal(await launch(t, async dir => {
    const versions = join(dir, 'claude/versions');
    await mkdir(versions, { recursive: true });
    for (const version of ['2.1.309', '2.1.310', '2.1.312', '2.1.314']) await fake(join(versions, version), `${version} (Claude Code)`);
    await writeFile(join(versions, '2.1.315.download'), 'partial');
    await writeFile(join(versions, '2.1.316'), 'not executable', { mode: 0o600 });
    return join(versions, '2.1.310');
  }), '2.1.314 (Claude Code)');
});

test('a binary outside the versions directory is used exactly as configured', async t => {
  assert.equal(await launch(t, async dir => {
    await fake(join(dir, '2.1.310'), 'custom');
    await fake(join(dir, '2.1.314'), 'sibling');
    return join(dir, '2.1.310');
  }), 'custom');
});
