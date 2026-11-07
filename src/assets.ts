import { Effect, FileSystem } from "effect";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compress } from "./http.ts";

interface Asset {
  readonly body: Buffer;
  readonly type: string;
  readonly hash: string;
  readonly etag: string;
  readonly br: Buffer;
  readonly gzip: Buffer;
}
export const loadAssets = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = fileURLToPath(new URL("../public/", import.meta.url));
  const assets: Record<string, Asset> = {};
  const paths = [
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
    ...[400, 500, 600, 700].map((w) => [
      `/fonts/poppins-${w}.woff2`,
      `fonts/poppins-${w}.woff2`,
      "font/woff2",
    ]),
  ];
  for (const [path, name, type] of paths) {
    const body = Buffer.from(yield* fs.readFile(`${dir}${name}`));
    const hash = createHash("sha256")
      .update(body)
      .digest("base64url")
      .slice(0, 16);
    assets[path] = {
      body,
      type,
      hash,
      etag: `W/"${hash}"`,
      br: compress(body, "br"),
      gzip: compress(body, "gzip"),
    };
  }
  const indexHTML = (yield* fs.readFileString(`${dir}index.html`)).replace(
    /\.\/(app\.js|style\.css)"/g,
    (_, name: string) => `./${name}?v=${assets[`/${name}`].hash}"`,
  );
  return { assets, indexHTML };
});
