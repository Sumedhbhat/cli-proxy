import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, FileSystem } from "effect";
import { build } from "esbuild";

NodeRuntime.runMain(
  Effect.all(
    [
      Effect.tryPromise(() =>
        build({
          entryPoints: ["scripts/recovery-main.ts"],
          outfile: "dist/recovery.cjs",
          bundle: true,
          format: "cjs",
          platform: "node",
          target: "node24",
        }),
      ),
      Effect.tryPromise(() =>
        build({
          entryPoints: ["scripts/maintenance.ts"],
          outfile: "dist/maintenance.cjs",
          bundle: true,
          format: "cjs",
          platform: "node",
          target: "node24",
        }),
      ),
      Effect.tryPromise(() =>
        build({
          entryPoints: ["public/app.ts"],
          outfile: "public/app.js",
          bundle: true,
          format: "esm",
          platform: "browser",
          target: "es2024",
          minify: true,
          legalComments: "eof",
        }),
      ),
      Effect.tryPromise(() =>
        build({
          entryPoints: ["scripts/claude-client.ts"],
          outfile: "scripts/claude-client.js",
          platform: "node",
          format: "esm",
          target: "node24",
        }),
      ).pipe(
        Effect.andThen(
          Effect.flatMap(FileSystem.FileSystem, (fs) =>
            fs.chmod("scripts/claude-client.js", 0o700),
          ),
        ),
      ),
      Effect.tryPromise(() =>
        build({
          entryPoints: ["src/credential-helper.ts"],
          outfile: "dist/client-api-key.cjs",
          bundle: true,
          format: "cjs",
          platform: "node",
          target: "node24",
          minify: true,
          legalComments: "eof",
          define: { CREDENTIAL_ENV_PATH: '"__CLI_PROXY_ENV_FILE__"' },
        }),
      ),
    ],
    { concurrency: 2 },
  ).pipe(Effect.asVoid, Effect.provide(NodeFileSystem.layer)),
);
