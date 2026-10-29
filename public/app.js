const $ = s => document.querySelector(s);
const main = $('#main');
const gatewayOrigin = window.CLI_PROXY_BASE_URL || new URL('.', location.href).href.replace(/\/$/, '');
const providerNames = { claude: 'Claude', codex: 'Codex', xai: 'xAI', kimi: 'Kimi', antigravity: 'Antigravity', gemini: 'Gemini' };
const svg = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const navigationIcons = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  start: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
  accounts: '<rect x="8" y="3" width="8" height="6" rx="1.5"/><path d="M12 9v4M5 13h14M5 13v3M19 13v3"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="9" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/>',
  connect: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 12-5M16 18l2 2 4-5"/>',
  quota: '<path d="M4 19a9 9 0 1 1 16 0M12 12l5-5"/><circle cx="12" cy="12" r="1"/>',
  logs: '<path d="M8 21h11a2 2 0 0 0 2-2V7H9V5a2 2 0 0 0-4 0v12H3a2 2 0 0 0 4 0V7M11 11h6M11 15h6"/>',
  routing: '<path d="M3 6h5M12 6h9M3 12h10M17 12h4M3 18h3M10 18h11M8 3v6M13 9v6M6 15v6"/>',
};
for (const link of document.querySelectorAll('nav [data-page]')) {
  const icon = link.querySelector('span');
  icon.innerHTML = svg(navigationIcons[link.dataset.page]);
  icon.setAttribute('aria-hidden', 'true');
}
const marks = {
  claude: svg(Array.from({length:12}, (_,i) => { const angle=i*Math.PI/6; return `<path d="M${12+Math.cos(angle)*4} ${12+Math.sin(angle)*4}l${Math.cos(angle)*6.5} ${Math.sin(angle)*6.5}"/>`; }).join('')),
  codex: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="currentColor"/><path d="m8 7-3 5 3 5M16 7l3 5-3 5M13.5 6l-3 12" stroke="white" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  xai: svg('<path d="m4 3 16 18M20 3 4 21M7 3h3l10 12M4 9l10 12h3"/>'),
  kimi: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="5" fill="currentColor"/><path d="M7 6v12M8 12l8-6M8 12l8 6" fill="none" stroke="var(--bg)" stroke-width="2.2"/><circle cx="19" cy="4" r="2" fill="#8ea8f9"/></svg>',
  all: svg('<path d="M9 9H6a3 3 0 1 1 3-3v12a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3H9z"/>'),
};
const titles = { quota: 'Quota management', overview: 'Overview', start: 'Quick start', accounts: 'Accounts', connect: 'Connect account', logs: 'Activity log', routing: 'Routing settings' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pName = p => providerNames[p] || p;
const mark = p => `<span class="provider-mark ${esc(p)}" aria-hidden="true">${marks[p] || svg('<path d="m12 2 10 10-10 10L2 12z"/>')}</span>`;
let state = null, filter = 'all', showEmails = false, layout = 'ledger', sort = 'reset', search = '', busy = false, oauthTimer = null;
let page = location.hash.slice(1) || 'quota';
let theme = localStorage.getItem('cli-proxy-theme');
if (theme) document.documentElement.dataset.theme = theme;
const date = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Reset not reported';
function relative(iso) {
  if (!iso) return 'Reset not reported';
  const hours = (Date.parse(iso) - Date.now()) / 3600000;
  if (hours <= 0) return 'Reset passed · refresh needed';
  if (hours < 1) return `in ${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `in ${Math.round(hours)} ${Math.round(hours) === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}
function mask(value) {
  if (showEmails) return value;
  if (!value.includes('@')) return value;
  const suffix = value.endsWith('.json') ? '.json' : '';
  let core = suffix ? value.slice(0,-5) : value;
  const provider = Object.keys(providerNames).find(p => core.startsWith(`${p}-`));
  const prefix = provider ? `${provider}-` : '';
  if (prefix) core = core.slice(prefix.length);
  const [local, domain] = core.split('@');
  return `${prefix}${local[0] || ''}•••@${domain?.[0] || ''}•••${suffix}`;
}
const weekly = a => a.quota?.windows.find(w => /fable/i.test(w.id+w.label) && /7|seven|week/i.test(w.id+w.label)) || a.quota?.windows.find(w => /7[ _-]?day|7d|seven[ _-]?day|week/i.test(w.id+w.label));
const fresh = a => a.quota && Date.now() - Date.parse(a.quota.fetchedAt) <= 180000;
const pct = n => `${Math.round(n)}%`;
function bar(n) { return `<div class="bar ${n <= 0 ? 'empty' : n < 60 ? 'low' : ''}" role="meter" aria-label="Quota remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(n)}"><i style="width:${Math.max(0, Math.min(100,n))}%"></i></div>`; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 4500); }
async function api(path, options = {}) {
  const res = await fetch(`./api/${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await res.json();
  if (!res.ok || data.ok === false || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function load(renderPage = true) {
  try { state = await api('state'); if (renderPage) render(); }
  catch (e) { main.innerHTML = `<div class="empty"><h2>Console unavailable</h2><p>${esc(e.message)}</p><button class="button" data-action="reload">Try again</button></div>`; }
}
function heading(actions = '') {
  const loaded = state.accounts.filter(fresh).length;
  const sub = page === 'quota' ? `<span class="tiny-dot"></span>${state.accounts.length} credentials<span class="faint">/</span><span class="green">${loaded} loaded</span>` : ({ overview: 'One endpoint for your coding accounts.', accounts: 'Manage the credentials available to your gateway.', connect: 'Keep provider authentication in the local engine.', start: 'From a local gateway to every machine you work on.', logs: 'Gateway requests and account changes. Prompts are never recorded.', routing: 'Use expiring quota first. Keep existing sessions on their account.' })[page];
  return `<div class="page-head"><div><h1>${titles[page]}</h1><div class="subtitle">${sub}</div></div><div class="actions">${actions}</div></div>`;
}
function notices() {
  let html = state.demo ? '<div class="notice"><span class="notice-icon">◈</span><span>Demo workspace. These credentials and quota values are sample data. Inference is disabled.</span><a href="#start">Set up your gateway ↗</a></div>' : '';
  if (state.refreshError) html += `<div class="notice error"><span>Engine unavailable: ${esc(state.refreshError)}. Start it with <code>npm run engine</code>.</span><a href="#start">Setup instructions</a></div>`;
  if (state.schedulerError) html += `<div class="notice error">${esc(state.schedulerError)}</div>`;
  return html;
}
function summary() {
  const providers = [...new Set(['claude','codex', ...state.accounts.map(a => a.provider)])].slice(0, 4);
  return `<div class="summary-grid" style="--provider-count:${providers.length}">${providers.map(provider => {
    const pool = state.accounts.filter(a => a.provider === provider && !a.disabled), known = pool.filter(a => fresh(a) && weekly(a));
    const total = known.reduce((n,a) => n + weekly(a).remaining, 0);
    const first = known.map(weekly).filter(w => w.resetsAt).sort((a,b) => Date.parse(a.resetsAt)-Date.parse(b.resetsAt))[0];
    const label = provider === 'claude' && known.some(a => /fable/i.test(weekly(a).id + weekly(a).label)) ? '7-day Fable' : 'Weekly limit';
    return `<article class="summary-card"><div class="summary-top">${mark(provider)}${esc(pName(provider))}<small>${pool.length} ${pool.length === 1 ? 'credential' : 'credentials'}</small></div><div class="summary-label">${label}</div><div class="summary-number"><strong>${known.length ? pct(total) : '—'}</strong><span>of ${known.length * 100}%${known.length < pool.length ? ' known' : ''}</span></div><div class="segmented">${pool.length ? pool.map(a => fresh(a) && weekly(a) ? bar(weekly(a).remaining) : '<div class="bar"></div>').join('') : '<div class="bar"></div>'}</div><div class="summary-reset">${first ? `${relative(first.resetsAt)} · ${date(first.resetsAt)}` : 'No quota loaded'}</div></article>`;
  }).join('')}</div>`;
}
function quotaCell(w, account) {
  if (!w) return '<div class="quota-cell"><span class="faint">—</span></div>';
  return `<div class="quota-cell"><div class="quota-top"><span>${esc(w.label)}</span><strong>${pct(w.remaining)}</strong></div>${bar(w.remaining)}<div class="quota-reset" title="${esc(date(w.resetsAt))}">${account.quotaError ? 'Cached · ' : !fresh(account) ? 'Stale · ' : ''}${relative(w.resetsAt)}</div></div>`;
}
function rows(accounts, manage = false) {
  const sorted = [...accounts].sort((a,b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'remaining' ? (weekly(a)?.remaining ?? 101) - (weekly(b)?.remaining ?? 101) : (Date.parse(weekly(a)?.resetsAt) || Infinity) - (Date.parse(weekly(b)?.resetsAt) || Infinity));
  const ranks = state.ranks.filter(r => r.priority > 0);
  const next = ranks.find(r => accounts.some(a => a.id === r.id))?.id;
  return `<div class="${layout === 'cards' ? 'card-view' : ''}">${layout === 'ledger' ? '<div class="ledger-head"><span>Credential</span><span>Weekly quota</span><span>Short window</span><span>Additional limit</span><span></span></div>' : ''}${sorted.map(a => {
    const w = weekly(a), windows = a.quota?.windows || [], hourly = windows.find(x => x !== w && /five|5.hour|5h|primary/i.test(x.id+x.label)), extra = windows.find(x => x !== w && x !== hourly);
    return `<article class="account-row"><div class="account-identity"><span class="account-name" title="${esc(mask(a.name))}">${esc(mask(a.name))}</span><div class="account-meta"><span>${esc(a.quota?.plan || a.plan || pName(a.provider))}</span>${a.disabled ? '<span class="paused-badge">Paused</span>' : next === a.id ? '<span class="next-badge">Next for new sessions</span>' : ''}${a.quotaError ? `<span class="error" title="${esc(a.quotaError)}">${a.quota ? 'Using cached quota' : 'Quota unavailable'}</span>` : ''}</div></div>${quotaCell(w,a)}${quotaCell(hourly,a)}${quotaCell(extra,a)}<button class="button quiet" data-action="${manage ? 'toggle-account' : 'refresh'}" data-id="${esc(a.id)}" ${busy ? 'disabled' : ''}>${manage ? a.disabled ? 'Resume' : 'Pause' : '↻ Refresh quota'}</button></article>`;
  }).join('')}</div>`;
}
function quotaPage() {
  const providers = [...new Set(state.accounts.map(a => a.provider))];
  const pool = state.accounts.filter(a => filter === 'all' || a.provider === filter);
  return heading(`<button class="button" data-action="emails">${showEmails ? 'Hide' : 'Show'} emails</button><button class="button primary" data-action="refresh" ${busy ? 'disabled' : ''}>↻ ${busy ? 'Refreshing…' : 'Refresh all'}</button>`) + notices()
    + `<div class="tabs-row"><div class="tabs" role="tablist" aria-label="Provider">${['all',...providers].map(p => `<button class="tab ${filter === p ? 'active' : ''}" role="tab" aria-selected="${filter === p}" data-filter="${esc(p)}">${mark(p)}${p === 'all' ? 'All providers' : esc(pName(p))}<span class="count">${p === 'all' ? state.accounts.length : state.accounts.filter(a => a.provider === p).length}</span></button>`).join('')}</div><select id="layout" aria-label="Quota layout"><option value="ledger" ${layout === 'ledger' ? 'selected' : ''}>Ledger view</option><option value="cards" ${layout === 'cards' ? 'selected' : ''}>Card view</option></select></div>`
    + summary() + (pool.length ? [...new Set(pool.map(a => a.provider))].map(p => `<div class="section-head"><h2>${mark(p)}${esc(pName(p))}<span>${pool.filter(a => a.provider === p).length} credentials</span></h2><span class="sort-hint">Ordered by next reset</span></div>${rows(pool.filter(a => a.provider === p))}`).join('') : '<div class="empty"><h2>No accounts connected</h2><p>Connect an account to see its quota and reset schedule here.</p><a class="button" href="#connect">Connect account</a></div>');
}
function overviewPage() {
  const successes = state.accounts.reduce((n,a) => n + a.success,0), failed = state.accounts.reduce((n,a) => n + a.failed,0);
  return heading('<a class="button primary" href="#connect">+ Connect account</a>') + notices() + summary() + `<div class="grid-two"><section class="panel"><h2>Your gateway</h2><p>Use this base URL in your coding client.</p><pre>${esc(gatewayOrigin)}/v1</pre><button class="button small" data-action="copy-url">Copy base URL</button><div class="field-row"><span>Engine connection</span><span class="${state.connected ? 'green' : 'error'}">${state.connected ? 'Connected' : 'Offline'}</span></div><div class="field-row"><span>Session affinity</span><span>${state.routing.affinity ? 'Enabled' : 'Disabled'}</span></div><div class="field-row"><span>Reset-first scheduler</span><span>${state.settings.scheduler ? 'Enabled' : 'Paused'}</span></div></section><section class="panel"><h2>Engine request totals</h2><div class="metric">${successes + failed}</div><p>${state.demo ? 'No real requests in demo mode.' : 'Credential counters reported by CLIProxyAPI. These may reset when the engine restarts.'}</p><div class="field-row"><span>Successful</span><span class="green">${successes}</span></div><div class="field-row"><span>Failed</span><span>${failed}</span></div><div class="field-row"><span>Quota last refreshed</span><span>${state.lastRefresh ? date(state.lastRefresh) : 'Not yet'}</span></div></section></div>`;
}
function accountsPage() {
  const pool = state.accounts.filter(a => `${a.name} ${a.provider} ${a.email}`.toLowerCase().includes(search.toLowerCase()));
  return heading('<button class="button" data-action="emails">'+(showEmails?'Hide':'Show')+' emails</button><a class="button primary" href="#connect">+ Connect account</a>') + notices() + `<div class="section-head"><h2>Credentials <span>${pool.length} total</span></h2><div class="actions"><input class="search" id="search" aria-label="Search accounts" placeholder="Search accounts…" value="${esc(search)}"><select id="sort" aria-label="Sort accounts"><option value="reset" ${sort === 'reset' ? 'selected' : ''}>Next reset</option><option value="remaining" ${sort === 'remaining' ? 'selected' : ''}>Least remaining</option><option value="name" ${sort === 'name' ? 'selected' : ''}>Account name</option></select></div></div>` + (pool.length ? rows(pool,true) : '<div class="empty">No matching credentials. Connect an account or change your search.</div>');
}
function connectPage() {
  return heading() + notices() + `<div class="grid-two">${['claude','codex'].map(p => `<section class="panel connect-card">${mark(p)}<h2>${pName(p)}</h2><p>Sign in through the engine’s OAuth flow. Your provider tokens stay in its local credential store.</p><button class="button primary" data-action="oauth" data-provider="${p}">Connect ${pName(p)}</button></section>`).join('')}</div><section class="panel" id="oauth-panel" hidden><h2>Complete sign-in</h2><p id="oauth-message"></p><a id="oauth-link" class="button primary" target="_blank" rel="noreferrer">Open provider sign-in ↗</a><form id="callback-form"><label>Callback URL<input type="url" name="redirect_url" placeholder="Paste the complete callback URL if the browser cannot reach localhost" required></label><button class="button" type="submit">Complete callback</button></form></section><section class="panel"><h2>Import an existing credential</h2><p>Select a CLIProxyAPI credential JSON file. The file is sent to the local engine; it is never saved in browser storage.</p><input type="file" id="credential-file" accept=".json,application/json" aria-label="Import credential JSON"></section>`;
}
function routingPage() {
  return heading() + notices() + `<div class="grid-two"><section class="panel"><h2>Account selection</h2><div class="field-row"><div><h3>Use the next reset first</h3><p>Prioritize fresh weekly quotas with the earliest reset. Existing sessions keep their account.</p></div><button class="switch" role="switch" aria-label="Reset-first scheduler" aria-checked="${state.settings.scheduler}" data-action="scheduler"><i></i></button></div><div class="field-row"><div><h3>Session affinity</h3><p>Handled by CLIProxyAPI across HTTP and WebSocket sessions.</p></div><span class="${state.routing.affinity ? 'green' : 'error'}">${state.routing.affinity ? 'Enabled' : 'Disabled'}</span></div><div class="field-row"><span>Engine strategy</span><code>${esc(state.routing.strategy || 'Unknown')}</code></div><div class="field-row"><span>Quota polling</span><span>Every ${state.settings.intervalSeconds} seconds</span></div><p>Pausing stops priority updates and leaves the last priorities in place. A backup is saved before the first enable; see the README to restore it.</p><p>Quota is stale after 3 minutes. Unknown quotas fall back to normal priority. Exhausted accounts are ranked last; the engine enforces cooldowns and retries.</p></section><section class="panel"><h2>New-session order</h2><p>Order is calculated separately for each provider. This is the proposed ranking; priorities apply only when scheduling is enabled and the engine is ready.</p>${state.ranks.map((r,i) => { const a = state.accounts.find(a => a.id === r.id); return `<div class="rank-row"><span class="rank-number">${i+1}</span><div>${esc(mask(a?.name))}<small>${esc(r.reason)}</small></div><span class="rank-priority">${r.priority}</span></div>`; }).join('') || '<p>No eligible credentials.</p>'}</section></div>`;
}
function logsPage() {
  return heading('<button class="button" data-action="reload">↻ Refresh</button>') + notices() + '<div class="notice">Only request paths, status codes, timing, and operational events are kept. This in-memory log holds the latest 200 entries and clears on restart.</div>' + (state.events.length ? state.events.map(e => `<div class="event"><time class="event-time">${esc(date(e.at))}</time><span class="event-kind">${esc(e.type)}</span><span>${esc(e.message)}${e.detail ? `<small class="error"> · ${esc(e.detail)}</small>` : ''}</span><span class="faint">${e.status || ''}${e.durationMs != null ? ` / ${e.durationMs}ms` : ''}</span></div>`).join('') : '<div class="empty">No activity yet. Requests and quota refreshes will appear here.</div>');
}
function startPage() {
  return heading() + notices() + `<div class="grid-two"><section class="panel prose"><h2>1. Prepare the gateway</h2><p>Requires Node.js 24+ and Linux or macOS. Run these commands in this repository.</p><pre>npm run setup\nnpm run engine</pre><p>Setup downloads CLIProxyAPI v8.0.23, verifies its checksum, and creates private local configuration. Run the console in a second terminal.</p><pre>npm start</pre><p>Open <code>http://127.0.0.1:8318</code>, or use your tailnet URL from another device. The dashboard opens directly without a console key.</p><h2>2. Connect your accounts</h2><p>Open Connect account, complete OAuth, then refresh quotas. You can also import existing CLIProxyAPI credential files. Codex credentials can enable upstream WebSockets by adding <code>"websockets": true</code> to their engine credential JSON.</p><a class="button small" href="#connect">Connect account</a></section><section class="panel prose"><h2>3. Point your coding clients here</h2><p>Use your <code>PROXY_API_KEY</code> from <code>.env</code> as the client key. Keep it separate from the engine management key.</p><p>Claude Code base URL</p><pre>ANTHROPIC_BASE_URL=${esc(gatewayOrigin)}\nANTHROPIC_AUTH_TOKEN=&lt;PROXY_API_KEY&gt;</pre><p>OpenAI-compatible / Codex provider base URL</p><pre>${esc(gatewayOrigin)}/v1</pre><p>Set the provider to the Responses wire API in Codex. Use a model ID available from <code>/v1/models</code>. The gateway forwards HTTP streaming and WebSocket upgrades at <code>/v1/responses</code>.</p><h2>4. Reach it over your tailnet</h2><p>Keep the engine and console on one always-on machine. Bind both to loopback and expose the console at a dedicated path on your Tailscale HTTPS address.</p><pre>tailscale serve --bg --https=443 --set-path=/cli-proxy/ http://127.0.0.1:8318</pre><p>Open the returned address with its trailing slash: <code>/cli-proxy/</code>. The existing T3 root and <code>/pages</code> routes stay available. Tailscale controls dashboard access. Coding clients still need the gateway API key.</p></section></div><section class="panel prose"><h2>How this relates to the video</h2><p>The proxy-specific features are implemented here: a consolidated quota view, reset-first priorities, account affinity, one gateway endpoint, and a loopback-first deployment. CLIProxyAPI owns OAuth refresh, model translation, inference, cooldowns, and provider WebSockets. The rest of the video covers agent workflows and machine management, which are outside this proxy.</p><p><a class="inline-link" href="https://www.youtube.com/watch?v=D8PikZ1KhUo" target="_blank" rel="noreferrer">Theo’s video</a> · <a class="inline-link" href="https://github.com/router-for-me/CLIProxyAPI" target="_blank" rel="noreferrer">CLIProxyAPI</a></p></section>`;
}
function render() {
  if (!state) return;
  page = titles[page] ? page : 'quota';
  document.title = `CLI Proxy · ${titles[page]}`;
  $('#breadcrumb').textContent = titles[page];
  $('#account-count').textContent = state.accounts.length;
  $('#connection-label').textContent = state.demo ? 'Demo workspace' : state.connected ? 'Gateway connected' : 'Engine offline';
  $('#mode').textContent = state.demo ? 'Demo mode' : 'Local gateway';
  $('#connection-detail').textContent = state.demo ? 'Sample data · no inference' : 'Local gateway · :8318';
  $('#footer-status').textContent = state.lastRefresh ? `Last synced ${date(state.lastRefresh)}` : 'Waiting for first sync';
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  main.innerHTML = ({ quota:quotaPage,overview:overviewPage,accounts:accountsPage,connect:connectPage,routing:routingPage,logs:logsPage,start:startPage })[page]();
}
window.addEventListener('hashchange', () => { page = location.hash.slice(1) || 'quota'; document.body.classList.remove('menu-open'); render(); });
$('#menu').addEventListener('click', () => document.body.classList.toggle('menu-open'));
$('#theme').addEventListener('click', () => { const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches); theme = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('cli-proxy-theme',theme); });
main.addEventListener('click', async e => {
  const filterButton = e.target.closest('[data-filter]'); if (filterButton) { filter=filterButton.dataset.filter; render(); return; }
  const button = e.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'emails') { showEmails=!showEmails; render(); }
    if (action === 'reload') await load();
    if (action === 'copy-url') { await navigator.clipboard.writeText(`${gatewayOrigin}/v1`); toast('Base URL copied'); }
    if (action === 'refresh') { busy=true; render(); try { await api('refresh',{method:'POST',body:{id:button.dataset.id}}); toast(state.demo ? 'Demo snapshot refreshed' : 'Quotas refreshed'); } finally { await load(); } }
    if (action === 'toggle-account') { const a=state.accounts.find(x=>x.id===button.dataset.id); await api('account',{method:'PATCH',body:{id:a.id,disabled:!a.disabled}}); await load(); toast(a.disabled?'Account resumed':'Account paused'); }
    if (action === 'scheduler') { await api('settings',{method:'PUT',body:{scheduler:!state.settings.scheduler}}); await load(); toast(state.settings.scheduler?'Reset-first scheduling enabled':'Scheduling paused'); }
    if (action === 'oauth') {
      const provider=button.dataset.provider; const data=await api('oauth/start',{method:'POST',body:{provider}});
      const url = new URL(data.url); if (url.protocol !== 'https:') throw new Error('Unexpected OAuth URL from engine');
      $('#oauth-panel').hidden=false; $('#oauth-panel').dataset.provider=provider; $('#oauth-link').href=data.url; $('#oauth-message').textContent='Open the sign-in page. This console will check for completion for 5 minutes.';
      clearInterval(oauthTimer); let attempts=0;
      oauthTimer=setInterval(async()=>{try{if(++attempts>150){clearInterval(oauthTimer);$('#oauth-message').textContent='Sign-in timed out. Start a new sign-in to try again.';return;} const s=await api(`oauth/status?state=${encodeURIComponent(data.state)}`); if(s.status==='ok'){clearInterval(oauthTimer);await api('refresh',{method:'POST',body:{}});await load(false);location.hash='accounts';toast('Account connected');}else if(s.status==='error'){clearInterval(oauthTimer);toast(s.error||'OAuth failed');}}catch(e){clearInterval(oauthTimer);toast(e.message);}},2000);
    }
  } catch (e) { toast(e.message); }
  finally { if(busy){busy=false;render();} }
});
main.addEventListener('change', async e => {
  if(e.target.id==='layout'){layout=e.target.value;render();}
  if(e.target.id==='sort'){sort=e.target.value;render();}
  if(e.target.id==='credential-file'){
    const file=e.target.files[0];if(!file)return;
    try{if(file.size>2*1024*1024)throw new Error('Credential files must be smaller than 2 MB');const credential=JSON.parse(await file.text());await api('import',{method:'POST',body:{name:file.name,credential}});await load(false);location.hash='accounts';toast('Credential imported');}catch(e){toast(e.message);}finally{e.target.value='';}
  }
});
main.addEventListener('input',e=>{if(e.target.id==='search'){search=e.target.value;const pos=e.target.selectionStart;render();$('#search').focus();$('#search').setSelectionRange(pos,pos);}});
main.addEventListener('submit',async e=>{if(e.target.id!=='callback-form')return;e.preventDefault();try{await api('oauth/callback',{method:'POST',body:{provider:$('#oauth-panel').dataset.provider,redirect_url:new FormData(e.target).get('redirect_url')}});toast('Callback submitted. Waiting for engine confirmation.');}catch(e){toast(e.message);}});
await load();
setInterval(()=>{if(!busy&&!['INPUT','SELECT'].includes(document.activeElement.tagName))load(['quota','overview','logs','routing'].includes(page));},15000);
