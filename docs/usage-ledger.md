# Usage ledger

The ledger records token usage for every execution that passes through this gateway, attributes it to the Claude or Codex account that served it and the device that sent it, and keeps three figures apart in the **Usage & cost** page:

- **Observed tokens**: counts reported by the provider.
- **API-equivalent value**: those tokens at public API list prices. This is an estimate, not a charge. Claude and ChatGPT subscriptions are not billed per token.
- **Actual spending**: only what billing records you enter or import say.

Only gateway traffic is covered, from the moment the ledger started. Usage before that, or from clients that call providers directly, cannot be rebuilt; quota percentages do not encode token counts.

## How records flow

```
client ──key──▶ gateway ──engine key + signed device──▶ CLIProxyAPI v8.0.59
                                                          │ usage.handle (per execution)
                                                          ▼
                                             cli-proxy-ledger plugin
                                             sanitize → fsync → usage-outbox/*.jsonl
                                                          │
                       console ingestion (every 2 s) ◀────┘
                       one SQLite transaction per batch: rows + byte offset
                                                          ▼
                                             .local/accounting.sqlite → /api/usage
```

**Why a plugin.** The engine publishes one usage record per upstream execution (`sdk/cliproxy/usage`), including each failed attempt, retry, and fallback, with the credential (`AuthID`) that handled it. Its built-in queue (`internal/redisqueue`) is in memory, expires, and is consumed by destructive reads, so polling it cannot be a reliable ledger. v8.0.59 can load standard dynamic-library plugins that receive the same records through `usage.handle`. The official release binary already supports them (it is built with cgo), so **no engine source change or fork is needed**: the engine stays the published, checksum-verified release.

**Ownership.** Each file has exactly one writer:

| Data | Writer | Readers |
| --- | --- | --- |
| `.local/usage-outbox/*.jsonl` | engine plugin (append-only) | console ingestion; deletes finished, ingested segments after 24 h |
| `.local/accounting.sqlite` | console only | console API |

**Outbox format** (version 1). One JSON object per line: `segment-start`, `usage`, `write-failures`, `segment-end` (with `"final": true` on a clean shutdown). A `usage` line holds only accounting fields: execution ID, parent request ID (`trace_id`), selection ID, provider, model and response model, credential ID, principal (`device:<id>`, `shared-key`, `anonymous`, or `other`), timestamps, latency, stream and outcome flags, status code, service tiers, reasoning effort, and the seven raw token counters. The plugin decodes nothing else from the engine record: prompts, responses, error bodies, response headers, base URLs, session IDs, and API keys never reach the outbox.

## Token semantics

The engine's raw counters are stored for audit; the ledger derives mutually exclusive buckets that add up to the total:

| Provider | Input | Cache read | Cache write | Output | Reasoning |
| --- | --- | --- | --- | --- | --- |
| Claude (Messages) | `input_tokens` (excludes cache) | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens` | subset of output |
| Codex (Responses) | `input_tokens − cached` | `cached_tokens` | cache writes, if reported | `output_tokens` | subset of output |

Reasoning is never added again. For Claude the engine's `CachedTokens` falls back to cache *creation*, so it is ignored. Unknown providers keep only their total.

Each execution is **complete**, **partial** (it failed or was interrupted after the provider reported some counts), or **unknown** (no counts were reported, for example a rejected request). Unknown is stored as `NULL`, never zero. **Estimated** is reserved for values that are not provider-reported; observed traffic never uses it.

Retries and fallbacks are separate executions with their own IDs and share a `trace_id`. A repeated delivery of the same execution is ignored by its primary key and counted under *Repeated deliveries ignored*.

## Failure handling and known gaps

| Situation | Behavior |
| --- | --- |
| Console stopped or restarting | The outbox keeps growing; ingestion catches up from the committed offset. |
| Console crash mid-ingestion | Rows and the segment offset commit in one transaction (`synchronous = FULL`); the batch is re-read and duplicates are absorbed. |
| SQLite failure (disk full, lock) | The transaction rolls back, the offset does not move, the dashboard shows *Ingestion is retrying*. |
| Outbox write failure in the engine | The plugin keeps up to 4,096 records in memory and retries on the next record. Overflow is counted with execution IDs in a `write-failures` marker shown as a gap. |
| Clean engine shutdown | Pending records are flushed and a final marker is written. Records still unwritten are listed (`lost-at-shutdown`). |
| Engine killed or crashed | Detected when the next engine starts (`unclean-stop`). A half-written last line is discarded (`torn-record`). |
| Ledger plugin not loaded | Inference keeps working through the engine's native key check, but nothing is recorded; the page shows a red notice. |

Gaps that cannot be closed without an engine change, documented rather than hidden:

- **Codex streams the client cancels are not recorded.** CLIProxyAPI v8.0.59 returns without publishing usage when the downstream request is cancelled (`internal/runtime/executor/codex_executor_stream.go`). The provider may still have counted those tokens. The gateway counts such requests itself (*Codex streams closed by the client*) so the size of the gap is visible.
- **Records queued inside the engine at shutdown.** The engine stops its HTTP server, then plugins, then its in-memory usage dispatcher (`sdk/cliproxy/service_lifecycle.go`). An execution that finishes in that window can be dropped before the plugin sees it. Clean shutdowns make this rare; kills are reported as `unclean-stop`.
- **Cache write duration.** The plugin record carries cache writes without their 5-minute/1-hour (Claude) or 30-minute/12-hour (OpenAI) split, so estimates are a low–high range.
- **Interrupted Claude streams** keep the counts from `message_start` plus the output reported before the cut; real usage may be higher.

The ledger is therefore not claimed to be lossless.

## Devices

The engine sees a single gateway credential, so its own API-key field cannot identify a device. Identity is established at the gateway:

1. **Usage & cost → Devices → Create key** issues a random 256-bit key (`cpk_…`), shown once and stored as a SHA-256 digest.
2. The gateway identifies the device from that key, replaces any client-supplied `X-CLI-Proxy-Device` header, and sends `X-CLI-Proxy-Device: <id>.<HMAC-SHA256(LEDGER_DEVICE_SECRET, id)>` with the engine key.
3. The plugin is the engine's exclusive client authenticator while loaded. It accepts only the configured engine key (by digest), verifies the signature, and reports the principal `device:<id>`. A request with an invalid signature is refused rather than misattributed. If the plugin fails to load, the engine falls back to its native key check and inference continues unattributed.

IP addresses, User-Agents, and labels sent by clients play no part. The existing `PROXY_API_KEY` keeps working and is reported as *Shared gateway key*. Configure a device by using its key wherever the shared key was used (`ANTHROPIC_AUTH_TOKEN` for Claude Code, the Codex provider key). Revoking a key refuses it immediately; its history stays.

## Prices

`src/pricing.ts` holds dated, immutable entries from the [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) and [OpenAI](https://developers.openai.com/api/docs/pricing) pricing pages, retrieved 2026-11-07 (catalog `2026-11-07.1`). Estimates use the model reported in the response, the resolved service tier (Claude `fast`; OpenAI standard, `priority`/fast, and flex), cache read and write rates, and long-context thresholds (OpenAI over 272K input, Claude Haiku 5.5 over 100K). Global routing is assumed; regional routing would add 10%.

To record a price change, close the current entry with `effectiveUntil` and add a new one with `effectiveFrom`; earlier days keep their price. Bump `ACCOUNTING_VERSION` in `src/accounting.ts` when the calculation rules change. Models, tiers, or dates without an entry show as **unknown value** and are listed under *Missing prices*.

## Billing records

There is no official billing API for Claude or ChatGPT subscriptions. Admin usage and cost APIs exist only for API organizations, which this gateway does not use, so no billing integration is included. Records are entered by hand or imported as CSV:

```csv
date,kind,provider,amount,currency,period_start,period_end,account,description
2026-11-01,subscription,claude,200.00,USD,2026-11-01,2026-11-30,,Max plan
```

Kinds: `subscription`, `credit_purchase`, `usage_charge`, `credit_consumption`, `refund`, `adjustment`. Spending is subscriptions + credit purchases + usage charges + adjustments − refunds. **Credit consumption is shown separately and never added**, because the money was counted when the credits were bought. Each import keeps its file name, a SHA-256 digest (the same file is refused twice), and the coverage period you state. A record counts toward a date range when its date or service period overlaps it. Spending is per account and period; dividing it across devices by token share would be an allocation, not a measurement, so the page does not do it.

## Build and deployment

| Component | Source | Pin |
| --- | --- | --- |
| Engine | official CLIProxyAPI release, MIT | v8.0.59 (commit `c5251b57`), SHA-256 checked by `npm run setup` |
| Ledger plugin | `engine-plugin/` in this repository, Go standard library only | built from this commit; the ABI shim is adapted from the engine's MIT-licensed example |
| Toolchain | Go 1.27.3 plus any C compiler (cgo) | `npm run plugin:build` warns on a different Go version |

v8.0.59 was released 2026-11-07, inside the 14-day dependency cooldown; adopting it early was an explicit owner decision because the usage fixes and plugin host it carries are what the ledger relies on.

Install or update the complete application, including the matching ledger plugin,
with one command from the checkout:

```sh
npm run setup
```

Setup checks the Go and C toolchains, installs npm dependencies, builds the plugin,
prepares the engine, deploys a complete release, configures clients, and verifies
readiness. The plugin manifest records its SHA-256, toolchain, and source commit.
`GO` and `CC` can select custom installed compilers. `npm run plugin:build` remains
a lower-level development command; it is not a required separate setup step.

The installed engine and plugin live together under
`~/.local/share/cli-proxy/releases/<release-id>/`. Credentials, the accounting
database, and the outbox remain in the stable `.local/` data directory. Setup
restarts both services during activation, which interrupts in-flight sessions.
See [deployment and recovery](deployment.md) for configuration, compatibility,
monitoring, and rollback behavior.

## Operating cost

No hosted service, paid dependency, or extra inference call. Per execution the engine writes one fsynced outbox line of about 0.7 KB (measured), deleted a day after ingestion, and the console stores one row; budget about 1 KB per execution including indexes, or roughly 1 GB per million executions. The engine loads a 3.8 MB plugin, which was added for the ledger. Each fsync adds a few milliseconds of disk work per execution in the engine's usage dispatcher, not in the response path. The gateway's request counters are buffered and written every two seconds, off the request path.

## Verification

`npm run check` runs the accounting, ingestion, and billing tests. `npm run test:engine` runs CLIProxyAPI v8.0.59 with the built plugin against a local mock provider through the gateway. It checks:

- device and fallback attribution
- Claude and Codex token semantics
- interrupted streams
- persistence across clean and killed engine restarts
- exports free of prompts, keys, and secrets

The Check workflow builds the plugin and runs that test on every pull request.
