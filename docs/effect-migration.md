# Effect migration

The application now uses TypeScript and Effect 4.0.6. Node 24 strips the types at runtime. esbuild bundles the browser entry, the stable Claude launcher, and the private credential helper; TypeScript checks the sources before tests run.

## Service boundaries

- `AppConfig` parses environment configuration once and stores service keys as `Redacted` values.
- `Engine` owns authenticated management calls, provider usage probes, optional reset-detail backoff, and the Claude version cache. Fetch receives Effect's cancellation signal; its timeout includes reading the response body.
- `Storage` reads validated settings, quota snapshots, and priority backups through Effect's filesystem service. Settings and snapshots use private temporary files and a rename in the same directory. A corrupt priority backup fails the update rather than replacing the rollback record.
- `Application` owns immutable snapshots in a `Ref`. A semaphore serializes refreshes and dashboard mutations. Refresh requests arriving in the same generation share the result; provider calls have concurrency three. The backup is saved before priorities change.
- `serve` owns the listener, request fibers, periodic refresh, and sockets in a scope. Disconnects interrupt request work. SIGINT and SIGTERM interrupt polling, abort outstanding fetches, and close the listener and tunnels through `NodeRuntime.runMain`.

Pure quota and routing functions remain ordinary TypeScript. Wrapping a calculation in an Effect would add no useful control over its behavior. The `record` helpers are confined to external payload interpretation; internal snapshots have schema-derived types.

## Transport

Node's HTTP streams keep backpressure for inference and bidirectional WebSockets. Effect scopes acquire and release the upstream requests and sockets. Catalog and refusal bodies are buffered with a byte limit because those responses need editing. Ordinary inference bodies and streams pass through.

Only the configured engine origin can receive the proxy key, even when a client sends an absolute request target. Cookies, management headers, proxy authorization, forwarded headers, and upstream cookies are stripped. Inference authentication, dashboard origin checks, route isolation, CSP, and the loopback listener are preserved.

JSON request bodies, configuration, persisted state, and engine envelopes are decoded at boundaries. Expected failures use tagged errors. Optional quota details may fail without discarding successful utilization data; failed refreshes retain the last provider snapshot and its original timestamp. Malformed scheduler settings fail startup. An unreadable or obsolete optional quota cache may be discarded.

## Commands and deployment

Setup downloads and checksums the same pinned engine release. Temporary extraction directories and child processes have scoped lifetimes. The service installer restarts previously active units if an update fails or is interrupted. It copies generated artifacts and the lockfile before installing production dependencies. Existing deployed credentials and settings remain private and are preserved.

The Claude launcher keeps its established `.js` executable path as generated output. It follows native Claude updates, passes through ordinary frames, and restores only reset metadata from a proxy refusal. Its stream transformer preserves UTF-8 and unterminated final lines.

The standalone key helper bundles Effect and its filesystem adapter. It reads the configured `.env` at execution time, so rotating the key requires no client settings change. Deployed start and client-configuration commands can use prebuilt artifacts without development dependencies.

## Verification

Run `npm ci` and `npm run check`. The check includes strict TypeScript, formatting, a migration contract, a fresh build, and the complete Node test suite. The migration contract rejects legacy application JavaScript, unchecked types, synchronous child-process execution, and bare background timers. Generated entry files and native transport timeouts are intentional exceptions.

The integration suite exercises HTTP streaming, authenticated WebSocket upgrades and refusals, model catalogs, caching across restarts, provider reset semantics, concurrent refreshes, request validation, private atomic writes, cancellation, and upstream-origin isolation. Command tests execute setup, client configuration, and service installation in temporary directories with fixture credentials and fake service managers.

Provider OAuth and inference with real credentials require a live account and are not exercised by this suite. The rewrite does not deploy or restart the existing service.
