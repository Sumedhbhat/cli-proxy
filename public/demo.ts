import { Effect, Schema } from "effect";
import { demoAccounts } from "../src/demo.ts";
import { rankAccounts } from "../src/quota.ts";
import { JsonObject } from "../src/domain.ts";
import type { DashboardState } from "../src/domain.ts";

window.CLI_PROXY_BASE_URL = "http://127.0.0.1:8318";
let state: DashboardState = {
  demo: true,
  connected: true,
  accounts: demoAccounts(),
  settings: { scheduler: true, intervalSeconds: 60 },
  routing: { strategy: "fill-first", affinity: true },
  refreshing: false,
  lastRefresh: new Date().toISOString(),
  refreshError: null,
  schedulerError: null,
  events: [],
  ranks: [],
};
window.fetch = (input, options = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const path =
        "/api/" +
        new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          location.href,
        ).pathname
          .split("/api/")
          .at(-1);
      const body =
        typeof options.body === "string"
          ? yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(JsonObject),
            )(options.body)
          : {};
      const response = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (path === "/api/state")
        return response({ ...state, ranks: rankAccounts(state.accounts) });
      if (path === "/api/refresh") {
        const now = new Date().toISOString();
        state = {
          ...state,
          lastRefresh: now,
          accounts: state.accounts.map((a) => ({
            ...a,
            quota: a.quota && { ...a.quota, fetchedAt: now },
          })),
        };
        return response({ ok: true });
      }
      if (path === "/api/settings" && typeof body.scheduler === "boolean") {
        state = {
          ...state,
          settings: { ...state.settings, scheduler: body.scheduler },
        };
        return response({ ok: true });
      }
      if (path === "/api/account" && typeof body.disabled === "boolean") {
        const disabled = body.disabled;
        state = {
          ...state,
          accounts: state.accounts.map((a) =>
            a.id === body.id ? { ...a, disabled } : a,
          ),
        };
        return response({ ok: true });
      }
      return response(
        {
          error:
            "This is the standalone demo. Run npm run setup in the repository to connect real accounts.",
        },
        409,
      );
    }),
  );
