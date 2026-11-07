import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { normalizeQuota } from "./quota.ts";
import { claudeUserAgent, defaultClaudeBinary } from "./claude-version.ts";
import { AppConfig } from "./config.ts";
import { EngineError, JsonObject, record } from "./domain.ts";
import type { Account, QuotaAccount } from "./domain.ts";

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}
export interface EngineOptions {
  readonly url: string;
  readonly key: string;
  readonly claudeBinary?: string | ReadonlyArray<string>;
}
const AuthFile = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.String,
    auth_index: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    provider: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    email: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    disabled: Schema.optional(Schema.Boolean),
    runtime_only: Schema.optional(Schema.Boolean),
    supports_quota: Schema.optional(Schema.Boolean),
    plan_type: Schema.optional(Schema.String),
  }),
  [JsonObject],
);
const AuthFiles = Schema.Struct({
  files: Schema.optional(Schema.Array(AuthFile)),
});
const ApiCall = Schema.Struct({
  status_code: Schema.Number,
  body: Schema.Unknown,
});

// Tokens remain in CLIProxyAPI. Only the engine can substitute $TOKEN$.
export const makeEngine = Effect.fn("Engine.make")(function* (
  options: EngineOptions,
) {
  const url = options.url.replace(/\/$/, "");
  const key = Redacted.make(options.key);
  const retryAt = new Map<string, number>();
  const version = yield* claudeUserAgent(
    options.claudeBinary ?? defaultClaudeBinary(),
  );
  const request = Effect.fn("Engine.request")(function* (
    path: string,
    { method = "GET", body, timeoutMs = 20000 }: RequestOptions = {},
  ) {
    // Timeout covers headers AND body; interruption aborts fetch and body consumption.
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${url}/v0/management/${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${Redacted.value(key)}`,
            ...(body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        const value: unknown = await response.json();
        return value;
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError(
        (cause) =>
          new EngineError({
            message: `Engine ${path.split("?")[0]} request failed`,
            cause,
          }),
      ),
    );
  });
  const decode = <S extends Schema.Constraint>(schema: S, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        (cause) =>
          new EngineError({ message: "Invalid engine response", cause }),
      ),
    );
  const authFiles = Effect.fn("Engine.authFiles")(function* (
    timeoutMs?: number,
  ) {
    return (
      (yield* decode(AuthFiles, yield* request("auth-files", { timeoutMs })))
        .files ?? []
    );
  });
  const accounts = Effect.fn("Engine.accounts")(function* () {
    return (yield* authFiles()).map((a): Account => ({
      id: String(a.auth_index ?? a.id ?? a.name),
      name: a.name,
      email: String(a.email || ""),
      provider: String(a.provider || a.type || "unknown"),
      disabled: Boolean(a.disabled),
      runtimeOnly: Boolean(a.runtime_only),
      status: String(a.status || "unknown"),
      priority: Number.isFinite(Number(a.priority)) ? Number(a.priority) : 0,
      supportsQuota: Boolean(a.supports_quota),
      accountId:
        typeof record(a.id_token).chatgpt_account_id === "string"
          ? (record(a.id_token).chatgpt_account_id as string)
          : null,
      plan: String(a.plan_type || ""),
      success: Number.isFinite(Number(a.success)) ? Number(a.success) : 0,
      failed: Number.isFinite(Number(a.failed)) ? Number(a.failed) : 0,
      quota: null,
      quotaError: null,
    }));
  });
  const apiCall = Effect.fn("Engine.apiCall")(function* (
    body: unknown,
    timeoutMs?: number,
  ) {
    const response = yield* decode(
      ApiCall,
      yield* request("api-call", { method: "POST", body, timeoutMs }),
    );
    if (response.status_code !== 200)
      return yield* new EngineError({
        message: `Quota endpoint returned HTTP ${response.status_code}`,
      });
    const payload =
      typeof response.body === "string"
        ? yield* Effect.try({
            try: () => JSON.parse(response.body as string) as unknown,
            catch: (cause) =>
              new EngineError({ message: "Invalid provider JSON", cause }),
          })
        : response.body;
    return yield* decode(JsonObject, payload);
  });
  const quota = Effect.fn("Engine.quota")(function* (account: QuotaAccount) {
    let data: JsonObject;
    if (account.supportsQuota)
      data = yield* decode(
        JsonObject,
        yield* request("quota/fetch", {
          method: "POST",
          body: { auth_index: account.id },
        }),
      );
    else {
      if (account.provider !== "claude" && account.provider !== "codex") {
        return yield* new EngineError({
          message:
            "No quota adapter; install a CLIProxyAPI quota plugin for this provider",
        });
      }
      const header: Record<string, string> = {
        Authorization: "Bearer $TOKEN$",
      };
      if (account.provider === "claude") {
        header["anthropic-beta"] = "oauth-2025-04-20";
        header["User-Agent"] = yield* version;
      }
      if (account.provider === "codex" && account.accountId)
        header["Chatgpt-Account-Id"] = account.accountId;
      data = yield* apiCall({
        auth_index: account.id,
        method: "GET",
        header,
        url:
          account.provider === "claude"
            ? "https://api.anthropic.com/api/oauth/usage?cedar_ember=1"
            : "https://chatgpt.com/backend-api/wham/usage",
      });
    }
    const resets = record(data.rate_limit_reset_credits);
    if (
      account.provider === "codex" &&
      Number(resets.available_count) > 0 &&
      !Array.isArray(resets.credits) &&
      (retryAt.get(account.id) ?? 0) <= Date.now()
    ) {
      retryAt.set(account.id, Date.now() + 300000);
      const details = yield* apiCall(
        {
          auth_index: account.id,
          method: "GET",
          url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
          header: {
            Authorization: "Bearer $TOKEN$",
            ...(account.accountId
              ? { "Chatgpt-Account-Id": account.accountId }
              : {}),
          },
        },
        2000,
      ).pipe(Effect.orElseSucceed(() => null));
      if (details && Array.isArray(details.credits)) {
        data = {
          ...data,
          rate_limit_reset_credits: { ...resets, credits: details.credits },
        };
        retryAt.delete(account.id);
      }
    }
    return yield* Effect.try({
      try: () => normalizeQuota(account.provider, data),
      catch: (cause) =>
        new EngineError({
          message: cause instanceof Error ? cause.message : "Invalid quota",
          cause,
        }),
    });
  });
  return {
    request,
    authFiles,
    accounts,
    quota,
    patch: (
      account: Pick<Account, "name">,
      fields: { readonly priority: number },
    ) =>
      request("auth-files/fields", {
        method: "PATCH",
        body: { name: account.name, ...fields },
      }),
    status: (account: Pick<Account, "name">, disabled: boolean) =>
      request("auth-files/status", {
        method: "PATCH",
        body: { name: account.name, disabled },
      }),
  };
});
export type EngineService = Effect.Success<ReturnType<typeof makeEngine>>;
export class Engine extends Context.Service<Engine, EngineService>()(
  "cli-proxy/Engine",
) {}
export const EngineLive = Layer.effect(
  Engine,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return yield* makeEngine({
      url: config.engineURL,
      key: Redacted.value(config.managementKey),
    });
  }),
);
