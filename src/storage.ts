import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { AppConfig } from "./config.ts";
import { PriorityBackup, QuotaCache, Settings } from "./domain.ts";

export const makeStorage = Effect.fn("Storage.make")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
  const read = <S extends Schema.ConstraintDecoder<unknown>>(
    name: string,
    schema: S,
  ) =>
    fs
      .readFileString(`${dir}/${name}`)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema)),
        ),
      );
  // Rename in the same directory gives readers either the old or complete new file.
  const write = Effect.fn("Storage.write")(function* (
    name: string,
    value: unknown,
  ) {
    yield* directory;
    const temp = `${dir}/.${name}.${randomUUID()}.tmp`;
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(temp, JSON.stringify(value, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      yield* fs.rename(temp, `${dir}/${name}`);
    }).pipe(
      Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.orDie)),
    );
  });
  const readBackup = read("priorities-backup.json", PriorityBackup).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed([])
        : Effect.fail(error),
    ),
  );
  return {
    loadSettings: fs.readFileString(`${dir}/settings.json`).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        ),
      ),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(Settings)({
          scheduler: false,
          intervalSeconds: 60,
          ...value,
        }),
      ),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed({ scheduler: false, intervalSeconds: 60 })
          : Effect.fail(error),
      ),
    ),
    // A missing or obsolete cache may be discarded; it never establishes usable quota.
    loadQuota: read("quota-cache.json", QuotaCache).pipe(
      Effect.orElseSucceed(() => []),
    ),
    readBackup,
    saveSettings: (settings: Settings) => write("settings.json", settings),
    saveQuota: (accounts: QuotaCache) => write("quota-cache.json", accounts),
    saveBackup: (backup: PriorityBackup) =>
      write("priorities-backup.json", backup),
  };
});
export type StorageService = Effect.Success<ReturnType<typeof makeStorage>>;
export class Storage extends Context.Service<Storage, StorageService>()(
  "cli-proxy/Storage",
) {}
export const StorageLive = Layer.effect(
  Storage,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return yield* makeStorage(config.dataDir);
  }),
);
