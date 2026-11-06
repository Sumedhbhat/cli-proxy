# CLI Proxy

A local console and gateway for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), inspired by the quota dashboard in [Theo's video](https://www.youtube.com/watch?v=D8PikZ1KhUo).

New sessions prefer the account whose weekly quota resets soonest. Existing sessions stay with their account through CLIProxyAPI's session affinity. The console shows remaining quota, provider reset times, available account resets, account status, and the proposed routing order.

## Try the interface

Requires Node.js 24 or newer. There are no npm packages to install.

```sh
npm run demo
```

Open http://127.0.0.1:8318. Demo mode uses sample accounts and rejects inference requests. Provider filters, email masking, account search, pause/resume, layout selection, routing controls, and themes work with the demo state. Demo changes disappear when the process restarts.

## Run with your accounts

Automatic engine installation supports Linux and macOS on x64 and arm64, with `tar` available.

```sh
npm run setup
npm run engine
```

In another terminal, after stopping any demo process:

```sh
npm start
```

Setup downloads CLIProxyAPI **v8.0.23**, published October 9, 2026, and verifies the archive against the release's SHA-256 checksum manifest. The pinned release meets the 14-day dependency cooldown. Setup preserves an existing `.env` and engine configuration.

Open http://127.0.0.1:8318 or your tailnet URL. The dashboard opens directly without a console key. Use **Connect account** for Claude or Codex OAuth. If the provider redirects to an unreachable localhost address, paste that complete callback URL into the console's callback field. Existing CLIProxyAPI credential JSON files can also be imported.

Both service keys are generated locally and kept out of Git:

| Variable | Purpose |
| --- | --- |
| `ENGINE_MANAGEMENT_KEY` | Server-side access to engine administration |
| `PROXY_API_KEY` | Authenticate coding clients at the gateway |

The engine's credential files are under `.local/auth/`. `.env`, engine configuration, settings, priority backups, and credentials are private local files. Don't commit them or publish them with the review page.

## Connect coding clients

On the proxy host, run the following to configure both installed CLIs automatically:

```sh
npm run clients:configure
```

This backs up your user settings under `~/.local/share/cli-proxy/client-config-backups/`, points Codex and Claude Code at the local gateway, and installs a private credential helper. The helper reads the API key from the deployed `.env`; you don't need to copy the key into either client's settings or export it from every shell. Restart existing CLI sessions after changing their configuration.

T3's managed Codex mode supplies its own provider settings and overrides the user configuration. On this host, the T3 Codex instance uses the existing CLI runtime with explicit proxy launch arguments. Its historical `openai_token_sharing` provider ID is retained so existing Codex histories can resume, but its endpoint is this proxy. The T3 Claude instance also has the proxy base URL set explicitly. These settings apply to new provider sessions; a running session may need to be reopened. This does not configure CLIs installed locally on another device, such as your Mac.

For provider-specific model lists, use `http://127.0.0.1:8318/codex/v1` as the Codex base URL and `http://127.0.0.1:8318/claude` as the Claude base URL. Their `/v1/models` responses contain only that provider's models. Inference and WebSockets use the same engine transport. The shared `/v1/models` endpoint continues to list all providers.

For manual configuration on another machine:

Claude Code reads the gateway URL and token from its environment. Use the `PROXY_API_KEY` value generated in `.env`:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8318
export ANTHROPIC_AUTH_TOKEN='<your PROXY_API_KEY>'
claude
```

For Codex, add a provider to your **user** `~/.codex/config.toml`. Set `model` to an ID available from the gateway's `/v1/models` endpoint:

```toml
model_provider = "cli-proxy"
# model = "<a model ID reported by /v1/models>"

[model_providers.cli-proxy]
name = "CLI Proxy"
base_url = "http://127.0.0.1:8318/v1"
env_key = "CLI_PROXY_API_KEY"
wire_api = "responses"
supports_websockets = true
```

Export `CLI_PROXY_API_KEY` with your `PROXY_API_KEY` value before starting Codex. To use a separate Codex setup, put this configuration under another `CODEX_HOME` instead of changing your normal installation.

The gateway tunnels WebSocket upgrades at `/v1/responses`. Provider-side WebSockets also need to be enabled in the engine: for a Codex credential, add the top-level field `"websockets": true` to its credential JSON. This is distinct from the client's `supports_websockets` setting. The engine owns WebSocket session selection and provider transport.

Client configuration references: [official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude Code gateway connection guide](https://code.claude.com/docs/en/llm-gateway-connect).

### Claude reset times in T3

For the Claude proxy instance, set **Settings → Providers → Claude → Binary path** to `~/.local/share/cli-proxy/scripts/claude-client.js` (use the full absolute path). The launcher runs the existing `~/.local/bin/claude` and preserves its stream, adding structured reset metadata only to proxy rate-limit refusals. Claude Code omits this metadata for API-key connections, so HTTP headers alone do not give T3 a reset countdown. New sessions use the launcher; existing sessions may need to be reopened. To run a different Claude Code binary, set `CLI_PROXY_CLAUDE_BINARY`. A path inside the native installer's `~/.local/share/claude/versions/` directory runs the newest installed release there, so Claude Code updates still take effect. To hold Claude Code at one release, for example to roll back, copy that release outside the `versions/` directory and point `CLI_PROXY_CLAUDE_BINARY` at the copy.

Every quota refresh still calls the provider. If the call fails, the gateway keeps the last successful quota and its original fetch time, including across console restarts. The dashboard labels this as **Using cached quota**. Claude rate-limit responses keep returning the cached provider reset time while it is still in the future, even if the quota snapshot is more than three minutes old, so T3 can schedule a retry. A successful refresh replaces the cached quota. If several exhausted windows block an account, the gateway waits for the latest of their resets; across accounts, it reports the earliest reset. Missing reset times and resets that have already passed are left unavailable. To remove the compatibility launcher, restore the Claude binary path to `~/.local/bin/claude`.

### Codex reset times in T3

Codex needs no launcher. Codex stops retrying a 429 only when the error has `type: "usage_limit_reached"` and an integer `resets_at`, and it publishes the exhausted window only from `x-codex-*` rate-limit headers. T3 takes its reset time and auto-resume from that published window. The engine's own refusal (`model_cooldown`) has neither. Over WebSockets the engine closes the socket without an error frame. Codex then retried for minutes, fell back to HTTPS, and slept toward the multi-hour `Retry-After` behind "exceeded retry limit, last status: 429".

When every enabled Codex credential has a quota cooldown in the engine, the gateway now:

- rewrites the 429 into Codex's usage-limit shape with the engine's nearest `retry_at`, and adds the provider's last recorded `x-codex-primary/secondary-*` headers. `x-codex-active-limit` is dropped, because it would point Codex at a header family that isn't present;
- refuses `/v1/responses` WebSocket upgrades with that same response. Codex reports a refused handshake directly instead of falling back.

Cooldowns are read fresh from `auth-files` (reused for 5 seconds). If the recorded windows predate the cooldown, only a primary window at 100% with the cooldown's reset time is sent. Transient cooldowns and pools with a usable credential pass through unchanged, so Codex keeps its normal retries. A WebSocket upgrade does not name a model, so model-only cooldowns are reported on the HTTPS fallback instead.

## Reach the gateway over Tailscale

Both processes bind to `127.0.0.1`. Run them on the machine you want to handle inference, then expose the console and client endpoint through Tailscale:

```sh
tailscale serve --bg --https=443 --set-path=/cli-proxy/ http://127.0.0.1:8318
```

Open `https://<machine>.<tailnet>.ts.net/cli-proxy/` (include the trailing slash). On this host the dashboard is [CLI Proxy](https://bhatsumedh.tail429e81.ts.net/cli-proxy/). Use that address without its trailing slash as the Claude base URL, or append `v1` to the dashboard address for Codex. Assets, dashboard API calls, and client inference all stay under `/cli-proxy/`; the existing T3 root and `/pages` routes remain available. Tailscale controls dashboard access; there is no separate console login. Coding clients still authenticate with the proxy API key. Use `tailscale serve --https=443 --set-path=/cli-proxy/ off` to remove only this route. The previous `:8443` address can stay available for existing clients. No Funnel is needed.

## Use an existing engine

Copy `.env.example` to `.env`, fill in two distinct strong keys, and set `ENGINE_URL`. The proxy key must be allowed by your engine's `api-keys` configuration. The generated setup uses the following engine settings:

```yaml
routing:
  strategy: fill-first
  session-affinity: true
  session-affinity-ttl: 1h
ws-auth: true
```

Enable scheduling in **Routing settings**. The companion refuses to apply priorities unless the engine reports `fill-first` and session affinity. It uses the engine's supported legacy `/v0/management` API, verified against v8.0.23.

## How scheduling works

Every 60 seconds, the companion reads the credential list and polls quotas with at most three requests in flight. It prefers the engine's normalized quota plugin response. Claude and Codex also have direct usage probes through the engine's `api-call` endpoint; provider tokens never enter this app or the browser.

Each Claude and Codex credential shows its unused quota resets on the Quota management and Accounts pages, in both ledger and card views. Codex reports the count in `rate_limit_reset_credits.available_count`; the Claude probe requests `cedar_ember` grants and counts active, unpaused grants. These are redeemable resets held by the account, separate from its scheduled quota reset times. A reported zero displays **0 resets available**; missing or unsupported data displays **Resets not reported**. Failed refreshes retain the previous count with a **Cached** label, and snapshots older than three minutes show **Stale**. The count is a provider snapshot and can change when a reset is spent or expires.

Below each positive balance, **Next reset expires** shows the earliest reported expiration, a countdown, and the date, year, and time in your browser's timezone. Codex expiry details come from a separate read-only `/wham/rate-limit-reset-credits` lookup; Claude uses the active grants' `ends_at` dates. Redeemed, paused, future, expired, and unsupported grants or credits are excluded as appropriate for the provider. If no expiry is reported or the Codex detail lookup fails, the balance remains visible with **Expiry not reported**. Cached and stale expiry dates retain those labels; a date that has passed says **refresh needed** until a provider refresh confirms the balance.

For each provider, healthy accounts with fresh quota receive descending priorities according to their next weekly reset. Claude's Fable weekly bucket is preferred when present; otherwise the first weekly bucket is used. Unknown or stale quotas get priority zero. Accounts with any exhausted reported window get a low priority, while CLIProxyAPI still enforces provider cooldowns and handles failover. Disabled and runtime-only accounts are untouched.

Priority is **per credential**, not per model. A model-specific quota window can therefore lower the priority of the whole credential. This is conservative and may leave usable quota on another model. The console does not claim that a quota timer replenished an account: only a fresh provider response updates its remaining quota. Snapshots become stale after three minutes.

Account priority affects new sessions. Established session bindings take precedence inside the engine. Keep client session headers intact and avoid changing accounts unnecessarily to preserve provider caches. The gateway forwards those headers without inspecting prompt bodies.

Before the scheduler changes priorities, it saves their original values in `.local/priorities-backup.json`. Pausing scheduling leaves the last priorities in place. To restore the originals, pause the scheduler, stop the console, leave the engine running, and run the restore from the directory the console runs in. It reads that directory's `.env` and `.local/`. For the persistent service, that is the installation:

```sh
cd ~/.local/share/cli-proxy
npm run restore-priorities
```

For a console started with `npm start`, run `npm run restore-priorities` in that checkout instead.

## Checks and limits

```sh
npm run check
```

Tests cover provider quota normalization, reset order, exhausted and stale quotas, account priority updates, dashboard access without login, cross-origin writes, API-key enforcement, streaming, WebSocket upgrades, and management-route isolation. The integration test uses a local fake engine and makes no model calls.

The installed engine was started and its management API was checked. Browser checks cover desktop and mobile layouts, filtering, search, email masking, and routing controls. **Real account OAuth, provider quota responses, and model inference still require your account sign-in and have not been exercised with real credentials.**

Claude and Codex have built-in quota probes. Other providers need a CLIProxyAPI quota plugin; their sample demo values do not imply live integration. The gateway supports the listed OpenAI-compatible endpoints and Anthropic Messages, including count-tokens. It does not expose every endpoint the engine offers.

The activity log stores only the latest 200 operational events in memory. It records request paths, status, and timing, not prompts, tokens, or inference bodies. This project does not add token-cost accounting. The rest of the video covers agent workflows and managing machines; see [the video review](docs/video-review.md) for the scope boundary.

Dashboard access has no separate login or session expiry. The app binds to loopback; Tailscale Serve provides access from your tailnet. Cross-origin dashboard writes are rejected.

## Keep it running

On Linux, stop any manually started engine and console, then run:

```sh
npm run service:install
```

This copies the app to `~/.local/share/cli-proxy/`, enables two systemd user services, and enables user lingering. The services start at boot without a desktop sign-in and restart after a failure. The installation survives closing T3 or removing this worktree. Tailscale Serve keeps the HTTPS listener configured across restarts.

On this host, NetworkManager and Tailscale are enabled at boot. Both saved Wi-Fi connections reconnect automatically with system-stored credentials, so networking does not wait for a desktop sign-in. After power is restored and the computer boots, the console becomes reachable once the network is back.

The deployed `.env`, credentials, and scheduler state live under `~/.local/share/cli-proxy/`. Subsequent service installs update the code and preserve those files. Poppins is bundled locally under the SIL Open Font License; no font CDN is used.

```sh
systemctl --user status cli-proxy-engine cli-proxy-console
journalctl --user -u cli-proxy-console -n 50
```
