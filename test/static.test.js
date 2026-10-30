import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

test('dashboard assets are compressed, pinned by hash, and the page carries its state', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-proxy-static-test-'));
  const probe = http.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const child = spawn(process.execPath, ['src/server.js', '--demo'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), DATA_DIR: dir } });
  t.after(async () => { child.kill('SIGTERM'); await once(child, 'exit'); await rm(dir, { recursive: true, force: true }); });
  for await (const chunk of child.stdout) if (String(chunk).includes('http://127.0.0.1')) break;
  const base = `http://127.0.0.1:${port}`;
  const get = (path, headers = {}) => fetch(base + path, { headers });

  const page = await get('/');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  const state = JSON.parse(/<script id="initial-state" type="application\/json">([^<]*)<\/script>/.exec(html)[1]);
  assert.equal(state.demo, true);
  assert.ok(state.accounts.length > 0);
  const script = /src="\.\/app\.js\?v=([\w-]+)"/.exec(html)[1];
  assert.match(html, /href="\.\/style\.css\?v=[\w-]+"/);

  const pinned = await get(`/app.js?v=${script}`);
  assert.equal(pinned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const etag = pinned.headers.get('etag');
  await pinned.arrayBuffer();
  const unpinned = await get('/app.js?v=stale');
  assert.equal(unpinned.headers.get('cache-control'), 'no-cache');
  await unpinned.arrayBuffer();
  assert.equal((await get('/app.js', { 'If-None-Match': etag })).status, 304);

  // fetch decodes transparently, so read the raw encoded body over http.
  const raw = await new Promise((resolve, reject) => http.get(`${base}/style.css`, { headers: { 'Accept-Encoding': 'gzip, br' } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject));
  assert.equal(raw.headers['content-encoding'], 'br');
  assert.match(brotliDecompressSync(raw.body).toString(), /@font-face/);

  const font = await get('/fonts/poppins-500.woff2', { 'Accept-Encoding': 'br' });
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(font.headers.get('content-encoding'), null);
  assert.equal(font.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  await font.arrayBuffer();
  assert.equal((await get('/fonts/poppins-500.ttf')).status, 404);
});
