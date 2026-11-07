import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const [html, css, bundle] = yield* Effect.all(
    [
      fs.readFileString(`${root}public/index.html`),
      fs.readFileString(`${root}public/style.css`),
      Effect.tryPromise(() =>
        build({
          stdin: {
            contents: "import './public/demo.ts'; import './public/app.ts';",
            resolveDir: root,
          },
          bundle: true,
          format: "esm",
          platform: "browser",
          target: "es2024",
          minify: true,
          write: false,
        }),
      ),
    ],
    { concurrency: 3 },
  );
  let embeddedCSS = css;
  for (const weight of [400, 500, 600, 700]) {
    const font = yield* fs.readFile(
      `${root}public/fonts/poppins-${weight}.woff2`,
    );
    embeddedCSS = embeddedCSS.replace(
      `./fonts/poppins-${weight}.woff2`,
      `data:font/woff2;base64,${Buffer.from(font).toString("base64")}`,
    );
  }
  const js = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const document = html
    .replace(/<link rel="preload"[^>]*>/g, "")
    .replace(
      '<link rel="stylesheet" href="./style.css">',
      () => `<style>${embeddedCSS}</style>`,
    )
    .replace(
      '<script type="module" src="./app.js"></script>',
      () => `<script type="module">${js}</script>`,
    );
  const out = resolve(process.argv[2] || ".local/review.html");
  yield* fs.makeDirectory(dirname(out), { recursive: true });
  yield* fs.writeFileString(out, document);
  console.log(out);
});
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
