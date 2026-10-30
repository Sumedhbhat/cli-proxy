import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { fallbackClaudeVersion } from '../src/claude-version.js';

// The Claude quota probe identifies itself as Claude Code. It used to send a hardcoded
// `claude-cli/2.1.288` that was never bumped, so every Claude Code update left the proxy
// reporting an older app than the one installed. The probe must ask the installed CLI.
async function probeUserAgent(t, script) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-proxy-claude-version-'));
  const binary = join(dir, 'claude');
  await writeFile(binary, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  let userAgent;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    userAgent = JSON.parse(raw).header['User-Agent'];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status_code: 200, body: JSON.stringify({ five_hour: { utilization: 1, resets_at: new Date(Date.now() + 3600000).toISOString() } }) }));
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const engine = new Engine({ url: `http://127.0.0.1:${server.address().port}`, key: 'test', claudeBinary: binary });
  await engine.quota({ id: '1', provider: 'claude', supportsQuota: false });
  return userAgent;
}

test('Claude quota probe reports the installed Claude Code version', async t => {
  assert.equal(await probeUserAgent(t, 'echo "2.4.501 (Claude Code)"'), 'claude-cli/2.4.501 (external, cli)');
});

test('Claude quota probe never reports a version older than the known fallback', async t => {
  assert.equal(await probeUserAgent(t, 'echo "2.0.1 (Claude Code)"'), `claude-cli/${fallbackClaudeVersion} (external, cli)`);
  assert.equal(await probeUserAgent(t, 'exit 1'), `claude-cli/${fallbackClaudeVersion} (external, cli)`);
});
