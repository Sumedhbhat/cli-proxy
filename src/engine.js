import { normalizeQuota } from './quota.js';

export class Engine {
  constructor({ url, key }) { this.url = url.replace(/\/$/, ''); this.key = key; }
  async request(path, { method = 'GET', body, raw = false } = {}) {
    const response = await fetch(`${this.url}/v0/management/${path}`, { method, headers: { Authorization: `Bearer ${this.key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error(`Engine ${path.split('?')[0]} returned HTTP ${response.status}`);
    return raw ? response.text() : response.json();
  }
  async accounts() {
    const data = await this.request('auth-files');
    return (data.files || []).map(a => ({ id: String(a.auth_index || a.id || a.name), name: a.name, email: a.email || '', provider: a.provider || a.type || 'unknown', disabled: Boolean(a.disabled), runtimeOnly: Boolean(a.runtime_only), status: a.status || 'unknown', priority: Number(a.priority) || 0, supportsQuota: Boolean(a.supports_quota), accountId: a.id_token?.chatgpt_account_id || null, plan: a.plan_type || '', success: Number(a.success) || 0, failed: Number(a.failed) || 0 }));
  }
  async quota(account) {
    if (account.supportsQuota) {
      const data = await this.request('quota/fetch', { method: 'POST', body: { auth_index: account.id } });
      return normalizeQuota(account.provider, data);
    }
    const probes = {
      claude: { url: 'https://api.anthropic.com/api/oauth/usage', header: { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20' } },
      codex: { url: 'https://chatgpt.com/backend-api/wham/usage', header: { Authorization: 'Bearer $TOKEN$' } },
    };
    const probe = probes[account.provider];
    if (!probe) throw new Error('No quota adapter; install a CLIProxyAPI quota plugin for this provider');
    if (account.provider === 'codex' && account.accountId) probe.header['Chatgpt-Account-Id'] = account.accountId;
    const response = await this.request('api-call', { method: 'POST', body: { auth_index: account.id, method: 'GET', ...probe } });
    if (response.status_code !== 200) throw new Error(`Quota endpoint returned HTTP ${response.status_code}`);
    return normalizeQuota(account.provider, typeof response.body === 'string' ? JSON.parse(response.body) : response.body);
  }
  patch(account, fields) { return this.request('auth-files/fields', { method: 'PATCH', body: { name: account.name, ...fields } }); }
  status(account, disabled) { return this.request('auth-files/status', { method: 'PATCH', body: { name: account.name, disabled } }); }
}
