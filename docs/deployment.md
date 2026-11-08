# Deployment and recovery

The development checkout is separate from the installed service. Run **one command**
from that checkout for first installation and every update:

```sh
npm run setup
```

It bootstraps locked npm dependencies even when `node_modules` is absent, builds
assets and the ledger plugin, prepares the engine, installs independent recovery
clients, deploys a verified release, configures CLI and detected T3 profiles, and
checks the running services. `npm run service:install` invokes the same workflow.
The individual scripts are internal steps, not additional commands to remember.

The command requires Linux, Node 24+, npm, Go 1.26+, a C compiler, tar, and systemd
user services. It checks them before changing dependencies or services; it does
not install operating-system packages. `GO` and `CC` may select existing toolchains.
It serializes complete setup runs, stops at the first failed step, and reports
which step failed. A failed activation must finish rollback before setup exits.
Only a fully completed run prints "Setup complete".

It detects relocated CLI homes through `~/.local/bin`, and detects T3 under that
home or `T3CODE_HOME`. For nonstandard layouts, `CLI_PROXY_CLIENT_HOME` and
`CLI_PROXY_T3_SETTINGS` select existing locations. These are configuration overrides,
not normally required steps. Proxy profiles are configured after successful service
activation. Direct recovery profiles are prepared beforehand. Existing T3 provider
history IDs are preserved; a Codex launcher supplies provider arguments directly,
without nested quoting in T3 settings. User settings are backed up before changes.

New provider sign-in still requires the user. Existing accounts, private keys, and
Tailscale Serve routes are preserved. Setup readiness does not imply available
subscription quota. It does not install anything on other machines.

The installation remains under `~/.local/share/cli-proxy` or
`$XDG_DATA_HOME/cli-proxy`. Existing installations may resolve through a symlink,
for example to `/workspaces/.local/share/cli-proxy`. Paths are resolved before
switching releases.

```text
cli-proxy/
  releases/<timestamp-id>/   complete code, dependencies, engine, plugin, manifest
  current -> releases/...   service startup location
  previous -> releases/...  last verified release
  .env                      shared private keys, retained across updates
  .local/                   shared accounts, settings, usage outbox, accounting DB
  maintenance.cjs           standalone monitoring and rollback controller
  recovery.cjs              standalone direct-client launcher
  deployment.json           activation/recovery record, no secrets
  incident.json             last incident, with recovery timestamp when healthy
```

`.env` and `.local` retain their legacy locations to preserve existing client
credential helpers and engine auth paths. The release contains a private copy of
engine configuration with stable auth/outbox paths and its own plugin directory.
Updates never overwrite the shared engine configuration, credentials, database,
or outbox. Old code left in the installation root is retained for investigation;
systemd runs `current/src/server.ts`, not those old files.

## Installation protocol

1. Acquire the installation lock. Concurrent deploys are rejected. A later run
   can reclaim a lock whose owner process has exited.
2. Recover an interrupted activation before preparing another candidate.
3. Copy code and build outputs into a fresh release directory. Install production
   dependencies there using `npm ci --omit=dev --ignore-scripts`.
4. Record hashes, runtime path, source commit when available, schema version, and
   engine version. Check the plugin checksum and required module imports.
5. Start the real candidate gateway and engine on temporary loopback ports with
   empty auth and isolated writable state. No real account probes, ingestion,
   scheduler mutations, or model generation occur. Verify management auth and
   authenticated provider model routes, three times consecutively. Check the
   binary's reported version. Stop these processes and remove temporary state.
6. Preserve existing systemd units and write an activation record before stopping
   services. Atomically replace `current`, install bounded service units, then
   start the engine and gateway.
7. Check the live release identity, management authentication, and authenticated
   Codex/Claude model routes three times before declaring success. Set `previous`
   only after successful verification.
8. On failure or handled SIGINT/SIGTERM, restore the previous complete release and
   unit files and verify recovery. A boot timer or next installer run also
   recovers a process killed during activation. Inspect the record if rollback
   itself fails; recovery never labels an unverified release healthy.

Preparing a release does not stop the current services. Activation restarts both
services and interrupts in-flight sessions, so deploy between sessions. Provider
quota exhaustion is separate from installation readiness. A successful model-list
check proves local routing and authentication, not that a subscription has quota.

The first conversion of a broken legacy installation has no verified previous
release. Back it up before conversion. If first activation fails, services stay
stopped with an explicit error; use the direct clients to repair it. Do not treat
that broken directory as a rollback target. Retain releases until manually
reviewed; the installer does not delete them automatically.

## Schema compatibility

This installer refuses a release with a different accounting schema from the
previous release. It also rejects a database newer than the candidate. Schema
changes require a separate migration and recovery plan. Rollback never replaces
an accounting database with an old snapshot or discards newly recorded usage.
For the initial conversion, the candidate can initialize its ledger using the
existing application's normal migration handling.

## Health and incidents

Both services use `Restart=on-failure`, a ten-second delay, and a maximum of five
starts within five minutes. `cli-proxy-health.timer` runs the independent
controller every minute and after boot. Service failures also trigger it.

The controller checks the release and transport without contacting provider
inference APIs, records one incident per failure episode, and marks it recovered
when healthy again. It reports to the systemd journal and a private local JSON
file. There is no external alert destination configured. Monitoring detects later
outages; automatic rollback runs for incomplete or failed activations, not quota
errors or arbitrary later outages.

```sh
systemctl --user status cli-proxy-engine cli-proxy-console cli-proxy-health.timer
journalctl --user -u cli-proxy-health.service -n 30
node ~/.local/share/cli-proxy/maintenance.cjs status
node ~/.local/share/cli-proxy/maintenance.cjs rollback
```

Use the installed Node executable if `node` is absent from your SSH PATH. The
controller is bundled and does not import the application's dependencies.

## Direct recovery clients

Setup automatically installs `codex-direct`
and `claude-direct` under `~/.local/bin`, backed by a standalone file outside the
releases. Set `CLI_PROXY_CLIENT_HOME` during installation when CLI homes live
elsewhere. Each launcher uses normal provider authentication and strips inherited
proxy endpoints and API keys. It does not copy credentials, automatically switch
an existing session, or route usage through the ledger.

Setup configures detected T3 profiles automatically. For an advanced, recovery-only update with an explicit existing settings path:

```sh
node scripts/install-recovery.ts --t3-settings=/path/to/.t3/userdata/settings.json
```

This backs up settings and adds **Codex (Direct recovery)** and **Claude (Direct
recovery)** instances. Existing proxy instances and running sessions are retained.
T3 watches its settings file; choose a direct instance for a new recovery session.
The Claude launcher omits user/project settings for that invocation to avoid
reloading the gateway or its credential helper. Native authentication remains
available. Authenticate the direct profiles before relying on them in an outage.

The recovery flags follow the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [Claude settings precedence](https://code.claude.com/docs/en/settings), and
are checked against the installed CLIs. Direct profiles require valid native
provider login; subscription credentials imported into the proxy are not a
substitute for that login.

## Versioned diagnostics

`npm run service:status` prints the selected and running release, Git commit,
engine version, build digest, service restart counts, and last independent health
heartbeat. Add `-- --json` for machine-readable output. An unhealthy service exits
nonzero. This command uses the installed standalone controller, so missing
application dependencies cannot prevent inspection.

Every ordinary HTTP response and supported WebSocket handshake carries
`X-CLI-Proxy-Release`, `X-CLI-Proxy-Commit`, `X-CLI-Proxy-Build`, and
`X-CLI-Proxy-Request-ID`. `/healthz` also reports startup time and uptime. The
release manifest records whether the source had uncommitted changes.

Private structured logs live in `.local/diagnostics/`: `setup.jsonl`,
`deploy.jsonl`, `health.jsonl`, and `app.jsonl`. Each rotates at 2 MiB and retains
three prior segments. Events contain stages, sanitized failure codes, timing,
response status and release identity. They do not include prompts, response
bodies, query strings, credentials, or arbitrary exception text. Request IDs
connect a response to its request event. Health records are independent of
application request traffic. Logs survive release switches and rollbacks.

Export a sanitized diagnostic report from the dashboard's Logs page or run:

```sh
npm run service:diagnostics -- --output=/tmp/cli-proxy-diagnostics.json
```

The export includes expected/running versions, service state and restarts, recent
safe events, incident state, import status and heartbeat age. It never exports
raw journal text or configuration secrets. There is still no external alert
service. A stale heartbeat is reported separately from transport health.

## Read-only usage recovery and collection

The usage page shows weekly quota observations and daily usage above the summary
cards. Project and conversation charts include token and value rankings,
conversation counts, observations per conversation, model/token mix, and the
distribution of tokens per task. A task means a whole T3 conversation. The mean,
median, minimum, maximum, range, population variance and standard deviation use
conversation totals in the selected date range. Conversations crossing range
boundaries are partial. Unmapped native sessions are excluded from task statistics
and counted explicitly in coverage.

The importer reads T3's existing `userdata/usage-scan-cache-v*.json`, its saved
`usage-model-rates.json`, and opens `statev2.sqlite` read-only for project and
conversation attribution. Supported normalized cache versions are 9, 10 and 11;
unknown versions fail instead of guessing. Global message deduplication prevents
copied/streamed Claude usage from being counted twice. Reasoning is already part
of output tokens and is never added twice. Parent session references group
subagent usage into its T3 conversation when that mapping exists.

```sh
npm run history:import -- --month=all
npm run history:import -- --month=2026-10
```

The second form also searches native CLI logs for retained quota observations.
Use `--export=/path/metadata.json` to export only usage metadata, then
`--file=/path/metadata.json` to import it on the service host. No prompts or
message bodies are exported. Imports are idempotent and stored in the proxy's
separate `.local/history.sqlite`. They never write to T3's cache, database,
settings, or code, and never trigger a T3 scan. These commands do not install an
engine on the machine performing an export.

Setup installs `cli-proxy-history.timer`, which reads the existing T3 cache every
five minutes. Its freshness depends on when T3 last scanned native usage. The
proxy independently records weekly quota observations during each normal account
refresh, including when the dashboard is closed. No historical quota curve is
inferred from token counts: missing samples stay gaps, recovered snapshots with
unknown accounts remain isolated points, and resets return toward 100% only when
observed. Historical Claude token usage can exist without historical Claude
quota percentages.

T3-retained rates or reported costs supply API-equivalent values for the history
charts. They are estimates, not subscription charges or proof of historical list
prices. Missing rates remain unpriced. The gateway cards continue using the dated
pricing catalog; historical observations before that catalog may be unpriced in
those cards. Historical usage is combined with gateway totals only before the
first gateway tracking day to avoid double counting. Account/device filters omit
native history because T3 does not establish those identities. Dates use UTC;
T3's local-time day boundaries can produce different daily totals.

For an update that must leave all T3 settings untouched, use:

```sh
CLI_PROXY_SKIP_T3=1 npm run setup
```

This runs the same installation workflow while skipping T3 profile configuration.
The history collector remains read-only. Normal CLI client configuration and
independent recovery launcher installation still run.

Project usage uses a share chart with summary statistics and a selectable measure.
It shows up to five projects contributing at least 5% each; all remaining projects
are available under Other projects. No projects are discarded. Quota lines join
only identified-account observations at most 15 minutes apart. Missing earlier
percentages and failed refreshes are shown explicitly.
