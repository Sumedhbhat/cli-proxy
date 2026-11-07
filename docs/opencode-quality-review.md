# OpenCode reference review

This review compared CLI Proxy at `61f674920383a6da2a60a854e1c3dae808671a8a` with [OpenCode revision `21bf6b493b76efcf3769ade999f05163760d61af`](https://github.com/anomalyco/opencode/tree/21bf6b493b76efcf3769ade999f05163760d61af), pinned on November 7, 2026. OpenCode uses Effect 4.1.0; CLI Proxy keeps its reviewed 4.0.6 dependencies. The comparison uses patterns supported by that installed version.

## Findings and fixes

1. **Refresh scope was missing from coalescing.** Concurrent refreshes for A and B, or A followed by “refresh all,” could complete after fetching only A. OpenCode's [shared cache key includes everything that changes the answer](https://github.com/anomalyco/opencode/blob/21bf6b493b76efcf3769ade999f05163760d61af/packages/core/src/shared-cache.ts#L11). CLI Proxy now records the completed generation and scope together. A full refresh covers queued account refreshes; a targeted refresh covers only the same account. Account mutations invalidate that coverage before attempting the change: a resumed account cannot reuse a full refresh that skipped it, including when a mutation's outcome is interrupted. The global mutation semaphore still protects snapshots and priority backups.
2. **Transport failures disappeared from activity.** An engine disconnect returned 502 without a failure event. OpenCode's [error mapping records operational failures before returning protected errors](https://github.com/anomalyco/opencode/blob/21bf6b493b76efcf3769ade999f05163760d61af/packages/server/src/handlers/session-error.ts#L21). CLI Proxy now uses `Effect.tapError` at the forwarding boundary to restore the failure event and preserve the original typed failure. Events contain no request body, query, credentials, or raw upstream cause.
3. **Response limits were attributed to the client.** The bounded reader returned “Request too large” and 413 for oversized engine catalogs and refusals. Callers now choose the limit error at their boundary: inbound request bodies retain 413; oversized upstream responses use a transport error and return 502. The same bounded reader serves both paths.
4. **Engine failures were wrapped twice.** Fetch and timeout failures now become `EngineError` at one boundary. Callers retain the original cause for diagnosis.
5. **Ownership lookup duplicated bounded reading.** It now uses the shared reader and JSON decoder. A scoped abort controller owns the fetch through body consumption, so disconnects and timeouts cancel the unfinished lookup.
6. **Refresh fixtures could drift from their services.** The refresh tests now use TypeScript layers checked against the production services. Unused mutation methods fail explicitly. The compiler checks these fixtures and the provider-test adapter in `npm run typecheck`.

The cleanup also uses OpenCode's [constant-recovery convention](https://github.com/anomalyco/opencode/blob/21bf6b493b76efcf3769ade999f05163760d61af/script/ast-grep/effect-simplifications/rules/no-effect-catch-succeed.yml): `Effect.orElseSucceed` expresses a fallback without another effect wrapper. Shared rank and event types derive from their schemas; quota selection narrows optional values without non-null assertions.

## Patterns that already fit

The small `Context.Service` and `Layer.effect` services follow the useful part of OpenCode's [service composition](https://github.com/anomalyco/opencode/blob/21bf6b493b76efcf3769ade999f05163760d61af/packages/core/src/file-write.ts#L52). Dependencies are captured at construction, quota and routing calculations stay pure, and transport lifetimes belong to scopes. Native HTTP adapters preserve streaming backpressure and WebSocket session behavior.

OpenCode's [live Effect test helpers](https://github.com/anomalyco/opencode/blob/21bf6b493b76efcf3769ade999f05163760d61af/packages/core/test/lib/effect.ts#L35) reinforce testing real platform behavior with explicit dependencies and cleanup. CLI Proxy's tests use local engines, temporary installations, controlled service layers, and real sockets and subprocesses. The new refresh tests use `Deferred` gates to exercise overlap without timing sleeps.

OpenCode's Bun tooling, monorepo layer graph, import conventions, and API framework are local choices. This review does not introduce those systems or update dependencies for stylistic parity. Its [Effect guidance](https://github.com/anomalyco/opencode/blob/21bf6b493b76efcf3769ade999f05163760d61af/.opencode/skills/effect/SKILL.md) is a reference; the installed Effect source determines API compatibility.

## Verification

Run `npm run check`. New coverage includes different targeted scopes, targeted-to-full overlap, a full refresh covering an account, matching targeted and full requests sharing work, a resumed account fetching quota after being skipped, disconnected upstreams, oversized catalogs and refusals, ownership-lookup failures and cancellation, and original engine error causes. Existing cancellation, streaming, quota, persistence, and installation tests remain in the full suite.
