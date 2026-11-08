import { recordQuota } from "./quota-history.ts";
import { appendDiagnostic, reasonCode } from "./diagnostics.ts";
import { Context, Effect, Layer, Ref, Semaphore } from "effect";
import { AppConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import { Storage } from "./storage.ts";
import { demoAccounts } from "./demo.ts";
import { rankAccounts } from "./quota.ts";
import { codexUsageLimit } from "./codex-limit.ts";
import { InputError, message, record } from "./domain.ts";
import type { Account, DashboardState, Event, JsonObject } from "./domain.ts";

export const makeApplication = Effect.gen(function* () {
  const config = yield* AppConfig;
  const engine = yield* Engine;
  const storage = yield* Storage;
  const settings = yield* storage.loadSettings;
  const cached = config.demo ? [] : yield* storage.loadQuota;
  const initial: DashboardState = {
    demo: config.demo,
    settings,
    accounts: config.demo
      ? demoAccounts()
      : cached.map((a) => ({
          ...a,
          name: a.id,
          provider: "unknown",
          email: "",
          disabled: false,
          runtimeOnly: false,
          status: "unknown",
          priority: 0,
          supportsQuota: false,
          accountId: null,
          plan: "",
          success: 0,
          failed: 0,
        })),
    connected: config.demo,
    routing: { strategy: "fill-first", affinity: true },
    refreshing: false,
    lastRefresh: null,
    refreshError: null,
    schedulerError: null,
    ranks: [],
    events: [],
  };
  const state = yield* Ref.make(initial);
  const mutations = yield* Semaphore.make(1);
  const completedRefresh = yield* Ref.make<{
    generation: number;
    scope: { readonly accountID?: string } | null;
  }>({ generation: 0, scope: null });
  const invalidateRefreshCoverage = Ref.update(
    completedRefresh,
    ({ generation }) => ({ generation, scope: null }),
  );
  const update = (f: (s: DashboardState) => DashboardState) =>
    Ref.update(state, f);
  const snapshot = Ref.get(state).pipe(
    Effect.map((s) => ({ ...s, ranks: rankAccounts(s.accounts) })),
  );
  const log = (
    type: string,
    message: string,
    details: Omit<Partial<Event>, "type" | "message" | "at"> = {},
  ) =>
    update((s) => ({
      ...s,
      events: [
        { at: new Date().toISOString(), type, message, ...details },
        ...s.events,
      ].slice(0, 200),
    }));
  const backupPriorities = Effect.gen(function* () {
    const backup = yield* storage.readBackup;
    const names = new Set(backup.map((a) => a.name));
    const accounts = (yield* Ref.get(state)).accounts.filter(
      (a) => !a.disabled && !a.runtimeOnly && !names.has(a.name),
    );
    yield* storage.saveBackup([
      ...backup,
      ...accounts.map(({ name, priority }) => ({ name, priority })),
    ]);
  });
  const applyPriorities = Effect.gen(function* () {
    yield* update((s) => ({ ...s, schedulerError: null }));
    const s = yield* Ref.get(state);
    if (!s.settings.scheduler || config.demo) return;
    if (s.routing.strategy !== "fill-first" || !s.routing.affinity) {
      yield* update((s) => ({
        ...s,
        schedulerError:
          "Engine needs routing.strategy: fill-first and routing.session-affinity: true. See Quick start.",
      }));
      return;
    }
    yield* backupPriorities;
    for (const rank of rankAccounts(s.accounts)) {
      const account = s.accounts.find((a) => a.id === rank.id)!;
      if (account.priority !== rank.priority) {
        yield* engine.patch(account, { priority: rank.priority });
        yield* update((s) => ({
          ...s,
          accounts: s.accounts.map((a) =>
            a.id === rank.id ? { ...a, priority: rank.priority } : a,
          ),
        }));
      }
    }
  });
  const refreshOnce = Effect.fn("Application.refreshOnce")(function* (
    accountID?: string,
  ) {
    if (config.demo) {
      const now = new Date().toISOString();
      yield* update((s) => ({
        ...s,
        lastRefresh: now,
        accounts: s.accounts.map((a) => ({
          ...a,
          quota: a.quota && { ...a.quota, fetchedAt: now },
        })),
      }));
      yield* log("quota", "Demo snapshot refreshed");
      return;
    }
    const previous = new Map(
      (yield* Ref.get(state)).accounts.map((a) => [a.id, a]),
    );
    const [latest, configuration] = yield* Effect.all(
      [engine.accounts(), engine.request("config")],
      { concurrency: 2 },
    );
    const routing = record(record(configuration).routing);
    const accounts = latest.map((a) => ({
      ...a,
      quota: previous.get(a.id)?.quota ?? null,
      quotaError: previous.get(a.id)?.quotaError ?? null,
    }));
    yield* update((s) => ({
      ...s,
      accounts,
      connected: true,
      refreshError: null,
      routing: {
        strategy:
          typeof routing.strategy === "string" ? routing.strategy : undefined,
        affinity: routing["session-affinity"] === true,
      },
    }));
    const refreshed = yield* Effect.forEach(
      accounts,
      (a) =>
        a.disabled || (accountID && a.id !== accountID)
          ? Effect.succeed(a)
          : engine.quota(a).pipe(
              Effect.map((quota) => ({ ...a, quota, quotaError: null })),
              Effect.catch((error) =>
                Effect.succeed({ ...a, quotaError: message(error) }),
              ),
            ),
      { concurrency: 3 },
    );
    if (config.dataDir && !config.demo)
      yield* Effect.try(() => recordQuota(config.dataDir, refreshed)).pipe(
        Effect.catch((error) =>
          Effect.tryPromise(() =>
            appendDiagnostic(config.dataDir, "app", {
              kind: "quota_history",
              status: "error",
              reason: reasonCode(error),
            }),
          ).pipe(Effect.catch(() => Effect.void)),
        ),
      );
    yield* update((s) => ({ ...s, accounts: refreshed }));
    yield* storage.saveQuota(
      refreshed.map(({ id, quota, quotaError }) => ({ id, quota, quotaError })),
    );
    yield* update((s) => ({ ...s, lastRefresh: new Date().toISOString() }));
    yield* applyPriorities.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* update((s) => ({ ...s, schedulerError: message(error) }));
          yield* log("error", "Priority update failed", {
            detail: message(error),
          });
        }),
      ),
    );
    yield* log(
      "quota",
      `Refreshed ${accounts.filter((a) => !a.disabled && (!accountID || a.id === accountID)).length} credentials`,
    );
  });
  const refresh = Effect.fn("Application.refresh")(function* (
    accountID?: string,
  ) {
    const observed = (yield* Ref.get(completedRefresh)).generation;
    yield* mutations.withPermit(
      Effect.gen(function* () {
        const completed = yield* Ref.get(completedRefresh);
        // A full refresh covers every account; a targeted refresh only covers itself.
        if (
          completed.generation !== observed &&
          completed.scope &&
          (!completed.scope.accountID ||
            completed.scope.accountID === accountID)
        )
          return;
        yield* update((s) => ({ ...s, refreshing: true }));
        yield* refreshOnce(accountID).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* update((s) => ({
                ...s,
                connected: false,
                refreshError: message(error),
              }));
              yield* log("error", "Engine unavailable", {
                detail: message(error),
              });
            }),
          ),
          Effect.ensuring(update((s) => ({ ...s, refreshing: false }))),
        );
        // Interruption has no result to share. A queued caller must do the refresh.
        yield* Ref.update(completedRefresh, (previous) => ({
          generation: previous.generation + 1,
          scope: { accountID },
        }));
      }),
    );
  });
  const setScheduler = (scheduler: boolean) =>
    mutations.withPermit(
      Effect.gen(function* () {
        const s = yield* Ref.get(state);
        if (!config.demo) {
          if (scheduler && !s.settings.scheduler) yield* backupPriorities;
          yield* storage.saveSettings({ ...s.settings, scheduler });
        }
        yield* update((s) => ({
          ...s,
          settings: { ...s.settings, scheduler },
        }));
        if (!config.demo) yield* applyPriorities;
        yield* log(
          "routing",
          `Reset-first scheduling ${scheduler ? "enabled" : "paused"}`,
        );
      }),
    );
  const setDisabled = (id: string, disabled: boolean) =>
    mutations.withPermit(
      Effect.gen(function* () {
        const account = (yield* Ref.get(state)).accounts.find(
          (a) => a.id === id,
        );
        if (!account)
          return yield* new InputError({
            status: 400,
            message: "Valid account id and disabled boolean required",
          });
        // A resumed account may have been skipped by an older full refresh.
        // Invalidate before the mutation: interruption can leave its outcome unknown.
        yield* invalidateRefreshCoverage;
        if (!config.demo) yield* engine.status(account, disabled);
        yield* update((s) => ({
          ...s,
          accounts: s.accounts.map((a) =>
            a.id === id ? { ...a, disabled } : a,
          ),
        }));
        yield* log(
          "account",
          `${account.provider} credential ${disabled ? "paused" : "resumed"}`,
        );
      }),
    );
  const importAccount = Effect.fn("Application.importAccount")(function* (
    name: string,
    credential: JsonObject,
  ) {
    yield* mutations.withPermit(
      Effect.gen(function* () {
        yield* invalidateRefreshCoverage;
        yield* engine.request(`auth-files?name=${encodeURIComponent(name)}`, {
          method: "POST",
          body: credential,
        });
      }),
    );
    yield* refresh();
  });
  const oauthStatus = Effect.fn("Application.oauthStatus")(function* (
    state: string,
  ) {
    const status = yield* engine.request(
      `get-auth-status?state=${encodeURIComponent(state)}`,
    );
    if (record(status).status === "ok") {
      // Wait for any older refresh to finish before invalidating its account list.
      yield* mutations.withPermit(invalidateRefreshCoverage);
    }
    return status;
  });
  const [files, invalidate] = yield* Effect.cachedInvalidateWithTTL(
    engine.authFiles(3000),
    5000,
  );
  const codexLimit = (model?: string) =>
    files.pipe(
      Effect.map((files) => codexUsageLimit(files, model)),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* invalidate;
          yield* log("error", "Codex cooldown lookup failed", {
            detail: message(error),
          });
          return null;
        }),
      ),
    );
  return {
    snapshot,
    log,
    refresh,
    setScheduler,
    setDisabled,
    importAccount,
    oauthStatus,
    codexLimit,
  };
});
export type ApplicationService = Effect.Success<typeof makeApplication>;
export class Application extends Context.Service<
  Application,
  ApplicationService
>()("cli-proxy/Application") {}
export const ApplicationLive = Layer.effect(Application, makeApplication);
