import { Data, Effect, Schedule, Schema } from "effect";
import { InputError, message } from "./domain.ts";

class DownloadError extends Data.TaggedError("DownloadError")<{
  readonly message: string;
  readonly retryable: boolean;
}> {}

const request = (url: string, accept: string, timeoutMs = 30_000) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        signal,
        headers: { Accept: accept },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new DownloadError({
          message: `${url}: HTTP ${response.status}`,
          retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
        });
      }
      return Buffer.from(await response.arrayBuffer());
    },
    catch: (cause) =>
      cause instanceof DownloadError
        ? cause
        : new DownloadError({
            message: `${url}: ${message(cause)}`,
            retryable: true,
          }),
  }).pipe(
    // The deadline includes reading the body; interruption aborts the request.
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new DownloadError({
            message: `${url}: download timed out after ${timeoutMs / 1000} seconds`,
            retryable: true,
          }),
        ),
    }),
  );

const retry = (download: Effect.Effect<Buffer, DownloadError>) =>
  Effect.retry(download, {
    times: 2,
    schedule: Schedule.exponential("1 second"),
    while: (error) => error.retryable,
  });
const Release = Schema.Struct({
  assets: Schema.Array(Schema.Struct({ name: Schema.String, id: Schema.Int })),
});
const api = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases";

export const downloadEngineRelease = Effect.fn("Engine.downloadRelease")(
  function* (version: string, asset: string) {
    const release = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}`;
    return yield* Effect.all(
      {
        archive: request(
          `${release}/${asset}`,
          "application/octet-stream",
          300_000,
        ),
        checksums: request(
          `${release}/checksums.txt`,
          "application/octet-stream",
        ),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.catchIf(
        (error) => error.retryable,
        (error) =>
          Effect.gen(function* () {
            console.warn(
              `Release download failed (${error.message}); trying GitHub's API asset route.`,
            );
            const metadata = yield* request(
              `${api}/tags/v${version}`,
              "application/vnd.github+json",
            ).pipe(retry);
            const decoded = yield* Effect.try({
              try: (): unknown => JSON.parse(metadata.toString("utf8")),
              catch: () =>
                new DownloadError({
                  message: "GitHub returned invalid release JSON",
                  retryable: false,
                }),
            });
            const release = yield* Schema.decodeUnknownEffect(Release)(
              decoded,
            ).pipe(
              Effect.mapError(
                () =>
                  new DownloadError({
                    message: "GitHub returned invalid release assets",
                    retryable: false,
                  }),
              ),
            );
            const downloadAsset = (name: string, timeoutMs: number) => {
              const entry = release.assets.find((entry) => entry.name === name);
              return entry
                ? request(
                    `${api}/assets/${entry.id}`,
                    "application/octet-stream",
                    timeoutMs,
                  ).pipe(retry)
                : Effect.fail(
                    new DownloadError({
                      message: `Release asset ${name} not found in v${version}`,
                      retryable: false,
                    }),
                  );
            };
            return yield* Effect.all(
              {
                archive: downloadAsset(asset, 300_000),
                checksums: downloadAsset("checksums.txt", 30_000),
              },
              { concurrency: 2 },
            );
          }),
      ),
      Effect.mapError(
        (error) =>
          new InputError({
            status: 502,
            message: `Engine download failed: ${error.message}`,
          }),
      ),
    );
  },
);
