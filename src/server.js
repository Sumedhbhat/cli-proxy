import http from 'node:http';
import https from 'node:https';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Engine } from './engine.js';
import { rankAccounts, nearestResetInfo, modelProvider } from './quota.js';
import { codexUsageLimit, codexLimitError } from './codex-limit.js';
import { demoAccounts } from './demo.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const demo = process.argv.includes('--demo');
const port = Number(process.env.PORT || 8318);
const engineURL = process.env.ENGINE_URL || 'http://127.0.0.1:8317';
const engine = new Engine({ url: engineURL, key: process.env.ENGINE_MANAGEMENT_KEY || '' });
const apiKey = process.env.PROXY_API_KEY;
if (!demo && (!apiKey || !process.env.ENGINE_MANAGEMENT_KEY)) {
  console.error('Run npm run setup first, or npm run demo to explore without credentials.');
  process.exit(1);
}
const dataDir = resolve(process.env.DATA_DIR || fileURLToPath(new URL('../.local/', import.meta.url)));
const settingsPath = `${dataDir}/settings.json`;
let settings = { scheduler: false, intervalSeconds: 60 };
try { settings = { ...settings, ...JSON.parse(await readFile(settingsPath, 'utf8')) }; } catch {}
let accounts = demo ? demoAccounts() : [];
if (!demo) {
  try { accounts = JSON.parse(await readFile(`${dataDir}/quota-cache.json`, 'utf8')); } catch {}
}
let connected = demo, lastRefresh = null, refreshError = null, refreshing = null;
let routing = { strategy: 'fill-first', affinity: true };
let schedulerError = null;
const events = [];
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const log = (type, message, details = {}) => { events.unshift({ at: new Date().toISOString(), type, message, ...details }); events.splice(200); };
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(req, max = 2 * 1024 * 1024) {
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > max) { const e = new Error('Request too large'); e.status = 413; throw e; } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { const e = new Error('Invalid JSON'); e.status = 400; throw e; }
}
function validOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
async function applyPriorities() {
  schedulerError = null;
  if (!settings.scheduler || demo) return;
  if (routing.strategy !== 'fill-first' || !routing.affinity) { schedulerError = 'Engine needs routing.strategy: fill-first and routing.session-affinity: true. See Quick start.'; return; }
  const ranks = rankAccounts(accounts);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let backup = [];
  try { backup = JSON.parse(await readFile(`${dataDir}/priorities-backup.json`, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const names = new Set(backup.map(a => a.name));
  for (const account of accounts) if (!names.has(account.name) && ranks.some(r => r.id === account.id)) backup.push({ name: account.name, priority: account.priority });
  await writeFile(`${dataDir}/priorities-backup.json`, JSON.stringify(backup, null, 2), { mode: 0o600 });
  for (const rank of ranks) {
    if (!settings.scheduler) break;
    const account = accounts.find(a => a.id === rank.id);
    if (account.priority !== rank.priority) {
      await engine.patch(account, { priority: rank.priority });
      account.priority = rank.priority;
    }
  }
}
async function refresh(accountID = null) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (demo) { lastRefresh = new Date().toISOString(); accounts.forEach(a => { a.quota.fetchedAt = lastRefresh; }); log('quota', 'Demo snapshot refreshed'); return; }
    try {
      const previous = new Map(accounts.map(a => [a.id, a]));
      const [latest, config] = await Promise.all([engine.accounts(), engine.request('config')]);
      routing = { strategy: config.routing?.strategy, affinity: config.routing?.['session-affinity'] === true };
      accounts = latest.map(a => ({ ...a, quota: previous.get(a.id)?.quota || null, quotaError: previous.get(a.id)?.quotaError || null }));
      connected = true; refreshError = null;
      // A small worker pool avoids blasting every provider when a large pool is imported.
      const queue = accounts.filter(a => !a.disabled && (!accountID || a.id === accountID));
      const refreshedCount = queue.length;
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
          const account = queue.shift();
          try { account.quota = await engine.quota(account); account.quotaError = null; }
          catch (e) { account.quotaError = e.message; }
        }
      }));
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(`${dataDir}/quota-cache.json`, JSON.stringify(accounts.map(({id, quota, quotaError}) => ({id, quota, quotaError}))), { mode: 0o600 });
      lastRefresh = new Date().toISOString();
      try { await applyPriorities(); } catch (e) { schedulerError = e.message; log('error', 'Priority update failed', { detail: e.message }); }
      log('quota', `Refreshed ${refreshedCount} credentials`);
    } catch (e) { connected = false; refreshError = e.message; log('error', 'Engine unavailable', { detail: e.message }); }
  })().finally(() => { refreshing = null; });
  return refreshing;
}
const inferencePath = path => /^\/v1\/(models|messages(?:\/count_tokens)?|chat\/completions|completions|responses(?:\/.*)?)$/.test(path);
// Provider-specific base URLs share inference transport but expose separate catalogs.
function scopeRequest(req) {
  const match = /^\/(codex|claude)(\/v1(?:\/|\?|$).*)/.exec(req.url);
  if (match) { req.catalogProvider = match[1]; req.url = match[2]; }
}
const authorized = req => equal(req.headers.authorization, `Bearer ${apiKey}`) || equal(req.headers['x-api-key'], apiKey);
function requestModel(body) {
  try { return JSON.parse(body).model; }
  catch { return /"model"\s*:\s*"([^"\\]{1,200})"/.exec(body.slice(0, 65536))?.[1]; }
}
// Cooldowns change when the engine sees a provider limit, so read them fresh. A
// short reuse window keeps a burst of refusals or reconnects to one engine call.
let authFilesRead = null;
async function codexLimit(model) {
  try {
    if (!authFilesRead || Date.now() - authFilesRead.at > 5000) authFilesRead = { at: Date.now(), files: engine.authFiles(3000) };
    return codexUsageLimit(await authFilesRead.files, model);
  } catch (e) { authFilesRead = null; log('error', 'Codex cooldown lookup failed', { detail: e.message }); return null; }
}
function proxy(req, res, upgradeHead) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const allowed = authorized(req);
  if (demo || !allowed) {
    if (upgradeHead !== undefined) { res.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    json(res, demo ? 503 : 401, { error: { message: demo ? 'Demo mode does not forward inference' : 'Invalid proxy API key' } }); return;
  }
  const target = new URL(req.url, engineURL);
  const headers = { ...req.headers, host: target.host };
  const filterModels = req.method === 'GET' && url.pathname === '/v1/models' && req.catalogProvider;
  if (filterModels) {
    headers['accept-encoding'] = 'identity';
    delete headers['if-none-match']; delete headers['if-modified-since'];
  }
  delete headers.cookie; delete headers['x-management-key']; delete headers['proxy-authorization'];
  for (const name of Object.keys(headers)) if (name.startsWith('x-forwarded-')) delete headers[name];
  headers.authorization = `Bearer ${apiKey}`;
  if (headers['x-api-key']) headers['x-api-key'] = apiKey;
  // Keep a bounded prefix: large Codex turns still name their model at the start.
  let requestBody = '', requestTooLarge = false;
  if (upgradeHead === undefined) req.on('data', chunk => {
    if (requestTooLarge) return;
    if (Buffer.byteLength(requestBody) + chunk.length > 2 * 1024 * 1024) requestTooLarge = true;
    else requestBody += chunk.toString();
  });
  const start = Date.now();
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(target, { method: req.method, headers }, response => {
    if (upgradeHead !== undefined) { res.end(`HTTP/1.1 ${response.statusCode} Upstream rejected upgrade\r\nConnection: close\r\n\r\n`); response.resume(); return; }
    const outputHeaders = { ...response.headers }; delete outputHeaders['set-cookie'];
    if (filterModels && response.statusCode === 200) {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { response.destroy(); res.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString());
          if (!Array.isArray(payload.data)) throw new Error('Invalid model catalog');
          payload.data = payload.data.filter(model => modelProvider(model.id) === req.catalogProvider);
          delete outputHeaders['content-length']; delete outputHeaders['transfer-encoding'];
          delete outputHeaders.etag; delete outputHeaders['content-encoding'];
          outputHeaders['cache-control'] = 'no-store';
          res.writeHead(200, outputHeaders); res.end(JSON.stringify(payload));
        } catch { json(res, 502, { error: { message: 'Invalid upstream model catalog' } }); }
      });
      response.on('error', () => res.destroy());
      return;
    }
    if (response.statusCode === 429) {
      const model = requestModel(requestBody);
      const provider = modelProvider(model) ?? (url.pathname.startsWith('/v1/responses') ? 'codex' : null);
      const resetInfo = provider === 'claude' ? nearestResetInfo(accounts, model) : null;
      const reset = resetInfo?.resetsAt;
      if (provider === 'codex' || reset) {
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) { response.destroy(); res.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('end', async () => {
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
          // Compressed or non-JSON errors retain their upstream representation.
          const editable = payload?.error && typeof payload.error.message === 'string' && !outputHeaders['content-encoding'];
          const limit = editable && provider === 'codex' ? await codexLimit(model) : null;
          if (limit) {
            payload.error = codexLimitError(limit, payload.error);
            delete outputHeaders['x-codex-active-limit'];
            Object.assign(outputHeaders, limit.headers, { 'x-ratelimit-reset': limit.resetsAt });
            log('limit', 'Codex usage limit reported to client', { status: 429, resetsAt: limit.resetsAt });
          } else if (editable && reset) {
            payload.error.message += ` Nearest Claude account reset: ${reset}.`;
            payload.error.resets_at = reset;
            outputHeaders['retry-after'] = String(Math.max(1, Math.ceil((Date.parse(reset) - Date.now()) / 1000)));
            outputHeaders['x-ratelimit-reset'] = reset;
            if (resetInfo.rateLimitType) {
              outputHeaders['anthropic-ratelimit-unified-status'] = 'rejected';
              outputHeaders['anthropic-ratelimit-unified-reset'] = String(Math.ceil(Date.parse(reset) / 1000));
              outputHeaders['anthropic-ratelimit-unified-representative-claim'] = resetInfo.rateLimitType;
            }
          } else { res.writeHead(429, outputHeaders); res.end(Buffer.concat(chunks)); return; }
          delete outputHeaders['content-length']; delete outputHeaders['transfer-encoding'];
          res.writeHead(429, outputHeaders); res.end(JSON.stringify(payload));
        });
        response.on('error', () => res.destroy());
        return;
      }
    }
    res.writeHead(response.statusCode, outputHeaders); response.pipe(res);
    response.on('end', () => log('request', `${req.method} ${url.pathname}`, { status: response.statusCode, durationMs: Date.now() - start }));
    response.on('error', () => res.destroy());
  });
  upstream.setTimeout(300000, () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => {
    log('error', 'Upstream connection failed');
    if (upgradeHead !== undefined) res.destroy();
    else if (!res.headersSent) json(res, 502, { error: { message: 'CLIProxyAPI engine unavailable' } }); else res.destroy();
  });
  if (upgradeHead !== undefined) {
    upstream.on('upgrade', (response, socket, head) => {
      res.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) res.write(head);
      if (upgradeHead.length) socket.write(upgradeHead);
      socket.pipe(res); res.pipe(socket);
      res.on('error', () => socket.destroy()); socket.on('error', () => res.destroy());
      res.on('close', () => socket.destroy()); socket.on('close', () => res.destroy());
      log('request', 'WebSocket connected', { status: 101 });
    });
    res.on('close', () => upstream.destroy()); upstream.end();
  } else {
    res.on('close', () => upstream.destroy()); req.pipe(upstream);
  }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    scopeRequest(req);
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (inferencePath(path)) { proxy(req, res); return; }
    if (path === '/healthz') { json(res, 200, { status: 'ok', demo }); return; }
    if (path.startsWith('/api/')) {
      if (req.method !== 'GET' && !validOrigin(req)) { json(res, 403, { error: 'Cross-origin request rejected' }); return; }
      // Dashboard access is provided by the loopback listener and Tailscale Serve.
      // Client inference below /v1 still requires the proxy API key.
      if (path === '/api/state' && req.method === 'GET') {
        json(res, 200, { demo, connected, accounts, settings, routing, refreshing: Boolean(refreshing), lastRefresh, refreshError, schedulerError, ranks: rankAccounts(accounts), events }); return;
      }
      if (path === '/api/refresh' && req.method === 'POST') {
        const data = await body(req);
        if (data.id != null && !accounts.some(a => a.id === data.id)) { json(res, 400, { error: 'Unknown account' }); return; }
        await refresh(data.id || null); json(res, 200, { ok: connected, error: refreshError }); return;
      }
      if (path === '/api/settings' && req.method === 'PUT') {
        const data = await body(req);
        if (typeof data.scheduler !== 'boolean') { json(res, 400, { error: 'scheduler must be a boolean' }); return; }
        if (!demo && data.scheduler && !settings.scheduler) {
          // Keep a rollback record before the companion starts owning credential priorities.
          await mkdir(dataDir, { recursive: true, mode: 0o700 });
          try { await writeFile(`${dataDir}/priorities-backup.json`, JSON.stringify(accounts.map(a => ({ name: a.name, priority: a.priority })), null, 2), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
        settings.scheduler = data.scheduler;
        if (!demo) { await mkdir(dataDir, { recursive: true, mode: 0o700 }); await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 }); await applyPriorities(); }
        log('routing', `Reset-first scheduling ${settings.scheduler ? 'enabled' : 'paused'}`);
        json(res, 200, { ok: true, warning: schedulerError }); return;
      }
      if (path === '/api/account' && req.method === 'PATCH') {
        const data = await body(req); const a = accounts.find(x => x.id === data.id);
        if (!a || typeof data.disabled !== 'boolean') { json(res, 400, { error: 'Valid account id and disabled boolean required' }); return; }
        if (!demo) await engine.status(a, data.disabled);
        a.disabled = data.disabled; log('account', `${a.provider} credential ${a.disabled ? 'paused' : 'resumed'}`); json(res, 200, { ok: true }); return;
      }
      if (path === '/api/oauth/start' && req.method === 'POST') {
        if (demo) { json(res, 409, { error: 'OAuth is available in live mode. Run npm run setup first.' }); return; }
        const { provider } = await body(req);
        if (!['claude', 'codex'].includes(provider)) { json(res, 400, { error: 'Choose Claude or Codex' }); return; }
        const data = await engine.request(`${provider === 'claude' ? 'anthropic' : provider}-auth-url?is_webui=true`);
        json(res, 200, { url: data.url, state: data.state }); return;
      }
      if (path === '/api/oauth/status' && req.method === 'GET') {
        if (demo) { json(res, 409, { error: 'OAuth requires live mode' }); return; }
        json(res, 200, await engine.request(`get-auth-status?state=${encodeURIComponent(url.searchParams.get('state') || '')}`)); return;
      }
      if (path === '/api/oauth/callback' && req.method === 'POST') {
        const data = await body(req);
        if (demo || !['claude','codex'].includes(data.provider) || typeof data.redirect_url !== 'string') { json(res, 400, { error: 'Provider and callback URL required in live mode' }); return; }
        json(res, 200, await engine.request('oauth-callback', { method: 'POST', body: { provider: data.provider, redirect_url: data.redirect_url } })); return;
      }
      if (path === '/api/import' && req.method === 'POST') {
        const { name, credential } = await body(req);
        if (!/^[\w.@+-]{1,160}\.json$/.test(name || '') || !credential || typeof credential !== 'object' || Array.isArray(credential)) { json(res, 400, { error: 'Provide a JSON credential file with a valid filename' }); return; }
        if (demo) { json(res, 409, { error: 'Credential import is available in live mode' }); return; }
        await engine.request(`auth-files?name=${encodeURIComponent(name)}`, { method: 'POST', body: credential });
        await refresh(); json(res, 200, { ok: true }); return;
      }
      json(res, 404, { error: 'Unknown endpoint' }); return;
    }
    const files = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'] };
    for (const weight of [400,500,600,700]) files[`/fonts/poppins-${weight}.ttf`] = [`fonts/poppins-${weight}.ttf`, 'font/ttf'];
    if (!files[path] || !['GET','HEAD'].includes(req.method)) { json(res, 404, { error: 'Not found' }); return; }
    const [name, type] = files[path]; res.setHeader('Content-Type', `${type}; charset=utf-8`); res.setHeader('Cache-Control','no-cache');
    res.end(req.method === 'HEAD' ? undefined : await readFile(`${publicDir}${name}`));
  } catch (e) { if (!res.headersSent) json(res, e.status || 502, { error: e.message }); else res.destroy(); }
});
server.on('upgrade', async (req, socket, head) => {
  // Node drops its socket error listener before 'upgrade'. Without one, a client
  // reset during the cooldown lookup is an uncaught exception.
  socket.on('error', () => socket.destroy());
  scopeRequest(req);
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path !== '/v1/responses' || !validOrigin(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  // When every Codex credential is cooling down the engine closes the socket without
  // an error frame, and Codex retries until it gives up. Refuse the upgrade with
  // Codex's usage-limit response instead; Codex reports that without retrying.
  const limit = !demo && authorized(req) ? await codexLimit() : null;
  if (limit) {
    const body = JSON.stringify({ error: codexLimitError(limit) });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Retry-After': Math.max(1, Math.ceil((Date.parse(limit.resetsAt) - Date.now()) / 1000)), 'X-Ratelimit-Reset': limit.resetsAt, ...limit.headers, Connection: 'close' };
    socket.end(`HTTP/1.1 429 Too Many Requests\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`);
    log('limit', 'Codex usage limit reported to client', { status: 429, resetsAt: limit.resetsAt });
    return;
  }
  proxy(req, socket, head);
});
const sockets = new Set();
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.listen(port, '127.0.0.1', () => { console.log(`CLI Proxy ${demo ? '(demo)' : ''}: http://127.0.0.1:${port}`); refresh(); });
const timer = setInterval(refresh, settings.intervalSeconds * 1000); timer.unref();
for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => { clearInterval(timer); server.close(); for (const socket of sockets) socket.destroy(); });
