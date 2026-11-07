import { Effect, Layer, Redacted } from "effect";
import { AppConfig } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import type { EngineService } from "../src/engine.ts";
import { Storage } from "../src/storage.ts";
import type { StorageService } from "../src/storage.ts";
import type { Account } from "../src/domain.ts";

export const account = (id: string): Account => ({
  id,
  name: `${id}.json`,
  provider: "codex",
  email: "",
  disabled: false,
  runtimeOnly: false,
  status: "active",
  priority: 0,
  supportsQuota: true,
  accountId: null,
  plan: "",
  success: 0,
  failed: 0,
  quota: null,
  quotaError: null,
});

// Every method is checked against its production service. Unexpected mutations
// fail the test instead of disappearing behind an incomplete fixture.
const unexpected = (operation: string) =>
  Effect.die(new Error(`Unexpected fixture call: ${operation}`));
export const applicationLayer = (options: {
  readonly accounts: ReadonlyArray<Account>;
  readonly quota: EngineService["quota"];
  readonly status?: EngineService["status"];
  readonly saveQuota?: StorageService["saveQuota"];
}) =>
  Layer.mergeAll(
    Layer.succeed(
      AppConfig,
      AppConfig.of({
        demo: false,
        dataDir: "",
        port: 0,
        engineURL: "http://unused",
        apiKey: Redacted.make("unused"),
        managementKey: Redacted.make("unused"),
      }),
    ),
    Layer.succeed(
      Engine,
      Engine.of({
        accounts: () => Effect.succeed([...options.accounts]),
        request: () => Effect.succeed({ routing: {} }),
        authFiles: () => Effect.succeed([]),
        quota: options.quota,
        patch: () => unexpected("Engine.patch"),
        status: options.status ?? (() => unexpected("Engine.status")),
      }),
    ),
    Layer.succeed(
      Storage,
      Storage.of({
        loadSettings: Effect.succeed({ scheduler: false, intervalSeconds: 60 }),
        loadQuota: Effect.succeed([]),
        saveQuota: options.saveQuota ?? (() => Effect.void),
        readBackup: unexpected("Storage.readBackup"),
        saveSettings: () => unexpected("Storage.saveSettings"),
        saveBackup: () => unexpected("Storage.saveBackup"),
      }),
    ),
  );
