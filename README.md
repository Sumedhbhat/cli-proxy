# CLI Proxy

A local console and gateway for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), inspired by the quota dashboard in [Theo's video](https://www.youtube.com/watch?v=D8PikZ1KhUo).

New sessions prefer usable accounts with the nearest weekly renewal or unused reset expiry, whichever comes first. Existing sessions stay with their account through CLIProxyAPI's session affinity. The console shows remaining quota, provider reset times, available account resets and their nearest expiry, account status, and the proposed routing order.

## Try the interface

Requires Node.js 24 or newer. Install the pinned dependencies first; npm also builds the browser bundle and client launchers.

```sh
npm ci
npm run demo
```

Open http://127.0.0.1:8318. Demo mode uses sample accounts and rejects inference requests. Provider filters, email masking, account search, pause/resume, layout selection, routing controls, and themes work with the demo state. Demo changes disappear when the process restarts.

## Run with your accounts

Automatic engine installation supports Linux and macOS on x64 and arm64, with `tar` available. Run `npm ci` in the checkout before using the setup commands.

```sh
npm run setup
npm run engine
```

In another terminal, after stopping any demo process:

```sh
npm start
```

Setup downloads CLIProxyAPI **v8.0.59**, published November 7, 2026, and verifies the archive against the release's SHA-256 checksum manifest. This release was adopted inside the 14-day dependency cooldown by explicit decision, because the usage ledger relies on its usage fixes and plugin host. Setup preserves existing `.env` and engine settings; it only adds the usage-ledger secret and plugin block when they are missing (see [Usage and cost](#usage-and-cost)).

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

Enable scheduling in **Routing settings**. The companion refuses to apply priorities unless the engine reports `fill-first` and session affinity. It uses the engine's supported legacy `/v0/management` API, verified against v8.0.59.

## How scheduling works

Every 60 seconds, the companion reads the credential list and polls quotas with at most three requests in flight. It prefers the engine's normalized quota plugin response. Claude and Codex also have direct usage probes through the engine's `api-call` endpoint; provider tokens never enter this app or the browser.

Each Claude and Codex credential shows its unused quota resets on the Quota management and Accounts pages, in both ledger and card views. Codex reports the count in `rate_limit_reset_credits.available_count`; the Claude probe requests `cedar_ember` grants and counts active, unpaused grants. These are redeemable resets held by the account, separate from its scheduled quota reset times. A reported zero displays **0 resets available**; missing or unsupported data displays **Resets not reported**. Failed refreshes retain the previous count with a **Cached** label, and snapshots older than three minutes show **Stale**. The count is a provider snapshot and can change when a reset is spent or expires.

Below each positive balance, **Next reset expires** shows the earliest reported expiration, a countdown, and the date, year, and time in your browser's timezone. Codex expiry details come from a separate read-only `/wham/rate-limit-reset-credits` lookup; Claude uses the active grants' `ends_at` dates. Redeemed, paused, future, expired, and unsupported grants or credits are excluded as appropriate for the provider. If no expiry is reported or the Codex detail lookup fails, the balance remains visible with **Expiry not reported**. Cached and stale expiry dates retain those labels; a date that has passed says **refresh needed** until a provider refresh confirms the balance.

The optional Codex detail lookup times out after two seconds. Failed lookups and responses without a credits array back off for five minutes per account, while quota polling continues normally.

For each provider, healthy accounts with fresh quota receive descending priorities by the earlier of their weekly renewal and nearest unused reset expiry. For example, an account renewing today with a credit expiring tomorrow comes before one renewing in three days with a credit expiring in five. A credit expiring today can also move an account ahead of one renewing tomorrow. Ties prefer the nearer weekly renewal, then the nearer credit expiry, then account ID. The default order on the Quota management and Accounts pages follows this same ranking.

Claude's Fable weekly bucket is preferred when present; otherwise the first weekly bucket is used. Five-hour reset times do not affect the deadline, but any exhausted reported window lowers the account's priority, even when unused resets remain. Reset credits affect routing while quota is usable; the scheduler does not redeem them. Missing, invalid, or expired credit details leave weekly ordering intact. Unknown or stale quotas get priority zero. CLIProxyAPI still enforces provider cooldowns and handles failover. Disabled and runtime-only accounts are untouched.

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

Strict TypeScript, formatting, and the migration contract run before the tests. Tests cover token accounting, pricing, billing imports, ingestion recovery, provider quota normalization, reset order, exhausted and stale quotas, account priority updates, dashboard access without login, cross-origin writes, API-key enforcement, streaming, WebSocket upgrades, and management-route isolation. Integration tests use local fake engines and make no model calls. `npm run test:engine` runs the real CLIProxyAPI v8.0.59 binary with the built ledger plugin against a local mock provider; CI runs it on every pull request. Command tests use temporary installations and fake service managers; they do not change the running deployment.

The installed engine was started and its management API was checked. Browser checks cover desktop and mobile layouts, filtering, search, email masking, and routing controls. **Real account OAuth, provider quota responses, and model inference still require your account sign-in and have not been exercised with real credentials.**

Claude and Codex have built-in quota probes. Other providers need a CLIProxyAPI quota plugin; their sample demo values do not imply live integration. The gateway supports the listed OpenAI-compatible endpoints and Anthropic Messages, including count-tokens. It does not expose every endpoint the engine offers.

The activity log stores only the latest 200 operational events in memory. It records request paths, status, and timing, not prompts, tokens, or inference bodies. Token accounting lives in the separate usage ledger below. The rest of the video covers agent workflows and managing machines; see [the video review](docs/video-review.md) for the scope boundary.

Dashboard access has no separate login or session expiry. The app binds to loopback; Tailscale Serve provides access from your tailnet. Cross-origin dashboard writes are rejected.

## Usage and cost

**Usage & cost** shows token usage for every execution that passes through this gateway, across Claude and Codex accounts and per device, with filters, daily trends, breakdowns, and CSV/JSON export. It keeps three figures apart:

- **Observed tokens** are the counts Claude and Codex reported. Cache reads, cache writes, and output are separate buckets; reasoning is part of output and is never added twice. Executions without reported usage are **unknown**, not zero.
- **API-equivalent value** prices those tokens at public API list prices from a dated catalog. It is an estimate of what the traffic would cost as API usage. Subscription usage is not billed per token, so it is not what you paid.
- **Actual spending** comes only from billing records you add or import: plan fees, credit purchases, and usage charges. Credit consumption is shown but never added again.

A small engine plugin (`engine-plugin/`, Go standard library only) writes sanitized usage metadata to an append-only outbox; the console ingests it into `.local/accounting.sqlite`. Prompts, responses, credentials, and error bodies are never stored. Give each machine its own key under **Devices**; the gateway signs the device identity for the engine, so attribution never depends on IP addresses or client-supplied labels. Coverage starts when the ledger starts, and known gaps, such as Codex streams a client cancels, are shown on the page.

Build the plugin with `npm run plugin:build` (Go 1.27.3 and a C compiler) before `npm run service:install`. Design, failure handling, the list of known gaps, pricing sources, billing import format, and deployment are in [the usage-ledger notes](docs/usage-ledger.md).

## Keep it running

On Linux, stop any manually started engine and console, then run:

```sh
npm run service:install
```

Run this from a checkout with development dependencies installed. It builds the browser bundle and launchers, copies the app and lockfile to `~/.local/share/cli-proxy/`, installs runtime dependencies with `npm ci --omit=dev --ignore-scripts`, enables two systemd user services, and enables user lingering. The services start at boot without a desktop sign-in and restart after a failure. The installation survives closing T3 or removing this worktree. Tailscale Serve keeps the HTTPS listener configured across restarts.

On this host, NetworkManager and Tailscale are enabled at boot. Both saved Wi-Fi connections reconnect automatically with system-stored credentials, so networking does not wait for a desktop sign-in. After power is restored and the computer boots, the console becomes reachable once the network is back.

The deployed `.env`, credentials, and scheduler state live under `~/.local/share/cli-proxy/`. Subsequent service installs update the code and preserve those files. Poppins is bundled locally under the SIL Open Font License; no font CDN is used.

```sh
systemctl --user status cli-proxy-engine cli-proxy-console
journalctl --user -u cli-proxy-console -n 50
```

## Effect implementation

Application sources are TypeScript executed by Node 24. Effect 4.0.6 manages I/O, failures, cancellation, and resource lifetimes. The Effect platform packages are pinned to the same release. All direct dependencies clear the 14-day release cooldown.

`Application` owns the quota snapshot and scheduler. `Engine`, `Storage`, and `AppConfig` are injectable services assembled with Layers. Quota normalization, account ranking, model filtering, and reset selection stay pure. HTTP streaming and WebSockets use Node's transport inside Effect scopes to retain backpressure and session headers.

Run `npm run build` after editing the dashboard. It generates the browser bundle, the stable `scripts/claude-client.js` launcher, and a standalone Effect credential helper. Generated JavaScript is ignored by Git. The helper contains the path to `.env`, never its contents, and works without the checkout or npm dependencies after installation.

The runtime and verification details are in [the migration notes](docs/effect-migration.md). The [OpenCode reference review](docs/opencode-quality-review.md) records the source comparison and its resulting fixes.
