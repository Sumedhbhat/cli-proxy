import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const hash = body => createHash('sha256').update(body).digest('base64url').slice(0, 16);

test('dashboard assets are compressed, pinned by hash, and the page carries its state', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-proxy-static-test-'));
  const probe = http.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const child = spawn(process.execPath, ['src/server.js', '--demo'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), DATA_DIR: dir } });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; await rm(dir, { recursive: true, force: true }); });
  const started = (async () => { for await (const chunk of child.stdout) if (String(chunk).includes('http://127.0.0.1')) return; })();
  await Promise.race([started, exited.then(([code]) => { throw new Error(`server exited before starting (${code})`); })]);
  const base = `http://127.0.0.1:${port}`;
  const get = (path, headers = {}) => fetch(base + path, { headers });

  const page = await get('/');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  const state = JSON.parse(/<script id="initial-state" type="application\/json">([^<]*)<\/script>/.exec(html)[1]);
  assert.equal(state.demo, true);
  assert.ok(state.accounts.length > 0);
  const script = /src="\.\/app\.js\?v=([\w-]+)"/.exec(html)[1];
  const style = /href="\.\/style\.css\?v=([\w-]+)"/.exec(html)[1];

  const pinned = await get(`/app.js?v=${script}`);
  assert.equal(pinned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const etag = pinned.headers.get('etag');
  assert.equal(hash(Buffer.from(await pinned.arrayBuffer())), script);
  const pinnedStyle = await get(`/style.css?v=${style}`);
  assert.equal(pinnedStyle.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(hash(Buffer.from(await pinnedStyle.arrayBuffer())), style);
  const unpinned = await get('/app.js?v=stale');
  assert.equal(unpinned.headers.get('cache-control'), 'no-cache');
  await unpinned.arrayBuffer();
  assert.equal((await get('/app.js', { 'If-None-Match': etag })).status, 304);
  assert.equal((await get('/app.js', { 'If-None-Match': `"other", ${etag.slice(2)}` })).status, 304);
  assert.equal((await get('/app.js', { 'If-None-Match': '*' })).status, 304);

  // fetch decodes transparently, so read the raw encoded body over http.
  const raw = await new Promise((resolve, reject) => http.get(`${base}/style.css`, { headers: { 'Accept-Encoding': 'gzip, br' } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject));
  assert.equal(raw.headers['content-encoding'], 'br');
  assert.match(brotliDecompressSync(raw.body).toString(), /@font-face/);
  const noBrotli = await new Promise((resolve, reject) => http.get(`${base}/style.css`, { headers: { 'Accept-Encoding': 'gzip, br;q=0' } }, res => { res.resume(); resolve(res.headers); }).on('error', reject));
  assert.equal(noBrotli['content-encoding'], 'gzip');

  const font = await get('/fonts/poppins-500.woff2', { 'Accept-Encoding': 'br' });
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(font.headers.get('content-encoding'), null);
  assert.equal(font.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  await font.arrayBuffer();
  assert.equal((await get('/fonts/poppins-500.ttf')).status, 404);
});
