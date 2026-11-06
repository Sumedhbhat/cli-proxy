import { normalizeQuota } from './quota.js';
import { claudeUserAgent, defaultClaudeBinary } from './claude-version.js';

export class Engine {
  constructor({ url, key, claudeBinary = defaultClaudeBinary() }) { this.url = url.replace(/\/$/, ''); this.key = key; this.claudeBinary = claudeBinary; this.resetDetailsRetryAt = new Map(); }
  async request(path, { method = 'GET', body, raw = false, timeoutMs = 20000 } = {}) {
    const response = await fetch(`${this.url}/v0/management/${path}`, { method, headers: { Authorization: `Bearer ${this.key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) throw new Error(`Engine ${path.split('?')[0]} returned HTTP ${response.status}`);
    return raw ? response.text() : response.json();
  }
  async authFiles(timeoutMs) { return (await this.request('auth-files', { timeoutMs })).files || []; }
  async accounts() {
    return (await this.authFiles()).map(a => ({ id: String(a.auth_index || a.id || a.name), name: a.name, email: a.email || '', provider: a.provider || a.type || 'unknown', disabled: Boolean(a.disabled), runtimeOnly: Boolean(a.runtime_only), status: a.status || 'unknown', priority: Number(a.priority) || 0, supportsQuota: Boolean(a.supports_quota), accountId: a.id_token?.chatgpt_account_id || null, plan: a.plan_type || '', success: Number(a.success) || 0, failed: Number(a.failed) || 0 }));
  }
  async quota(account) {
    let data;
    if (account.supportsQuota) {
      data = await this.request('quota/fetch', { method: 'POST', body: { auth_index: account.id } });
    } else {
      const probes = {
        claude: { url: 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1', header: { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20' } },
        codex: { url: 'https://chatgpt.com/backend-api/wham/usage', header: { Authorization: 'Bearer $TOKEN$' } },
      };
      const probe = probes[account.provider];
      if (!probe) throw new Error('No quota adapter; install a CLIProxyAPI quota plugin for this provider');
      if (account.provider === 'claude') probe.header['User-Agent'] = await claudeUserAgent(this.claudeBinary);
      if (account.provider === 'codex' && account.accountId) probe.header['Chatgpt-Account-Id'] = account.accountId;
      const response = await this.request('api-call', { method: 'POST', body: { auth_index: account.id, method: 'GET', ...probe } });
      if (response.status_code !== 200) throw new Error(`Quota endpoint returned HTTP ${response.status_code}`);
      data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
    }
    // Usage only reports the balance; the separate read-only endpoint lists expiry dates.
    const resets = data.rate_limit_reset_credits;
    if (account.provider === 'codex' && resets?.available_count > 0 && !Array.isArray(resets.credits) && !(this.resetDetailsRetryAt.get(account.id) > Date.now())) {
      // Optional failures back off for five minutes instead of delaying every quota poll.
      this.resetDetailsRetryAt.set(account.id, Date.now() + 300000);
      try {
        const response = await this.request('api-call', { method: 'POST', timeoutMs: 2000, body: {
          auth_index: account.id, method: 'GET', url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
          header: { Authorization: 'Bearer $TOKEN$', ...(account.accountId ? { 'Chatgpt-Account-Id': account.accountId } : {}) },
        } });
        if (response.status_code === 200) {
          const details = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
          if (Array.isArray(details?.credits)) {
            data = { ...data, rate_limit_reset_credits: { ...resets, credits: details.credits } };
            this.resetDetailsRetryAt.delete(account.id);
          }
        }
      } catch { /* Expiry lookup failure must not discard a successful quota refresh. */ }
    }
    return normalizeQuota(account.provider, data);
  }
  patch(account, fields) { return this.request('auth-files/fields', { method: 'PATCH', body: { name: account.name, ...fields } }); }
  status(account, disabled) { return this.request('auth-files/status', { method: 'PATCH', body: { name: account.name, disabled } }); }
}
