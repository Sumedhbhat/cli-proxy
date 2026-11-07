import { Effect, Schema } from "effect";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";
import { InputError, JsonObject, TransportError } from "./domain.ts";

export const requestURL = (req: IncomingMessage) =>
  Effect.try({
    try: () => new URL(req.url || "/", "http://localhost"),
    catch: () =>
      new InputError({ status: 400, message: "Invalid request URL" }),
  });

export const equal = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const validOrigin = (req: IncomingMessage) => {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
};
export const compress = (body: Buffer, encoding: "br" | "gzip") =>
  encoding === "br"
    ? brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } })
    : gzipSync(body);
const acceptedEncodings = (header: string | undefined) =>
  new Set(
    (header || "")
      .split(",")
      .map((part) => part.trim().split(/\s*;\s*/))
      .filter(
        ([name, ...params]) =>
          name && !params.some((p) => /^q=0(?:\.0*)?$/i.test(p)),
      )
      .map(([name]) => name.toLowerCase()),
  );
export const etagMatches = (header: string | undefined, etag: string) =>
  header != null &&
  (header.trim() === "*" ||
    (header.match(/(?:W\/)?"[^"]*"/g) || []).some(
      (tag) => tag.replace(/^W\//, "") === etag.replace(/^W\//, ""),
    ));
export function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
  variants?: { br: Buffer; gzip: Buffer },
) {
  const accept = acceptedEncodings(res.req.headers["accept-encoding"]);
  const encoding =
    body.length < 1024 || headers["Content-Type"].startsWith("font/")
      ? null
      : accept.has("br")
        ? "br"
        : accept.has("gzip")
          ? "gzip"
          : null;
  if (encoding) body = variants?.[encoding] || compress(body, encoding);
  res.writeHead(status, {
    ...headers,
    ...(encoding && { "Content-Encoding": encoding }),
    Vary: "Accept-Encoding",
    "Content-Length": body.length,
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}
export function json(res: ServerResponse, status: number, body: unknown) {
  send(
    res,
    status,
    { "Content-Type": "application/json", "Cache-Control": "no-store" },
    Buffer.from(JSON.stringify(body)),
  );
}
export const readBounded = (
  stream: AsyncIterable<Uint8Array>,
  max = 2 * 1024 * 1024,
) =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > max)
          throw new InputError({ status: 413, message: "Request too large" });
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    catch: (cause) =>
      cause instanceof InputError
        ? cause
        : new TransportError({ message: "Stream interrupted", cause }),
  });
export const body = (req: IncomingMessage) =>
  readBounded(req.iterator({ destroyOnReturn: false })).pipe(
    Effect.flatMap((bytes) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
        bytes.toString() || "{}",
      ),
    ),
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new InputError({ status: 400, message: "Invalid JSON object" }),
      ),
    ),
  );
export const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(
  req: IncomingMessage,
  schema: S,
) =>
  body(req).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new InputError({ status: 400, message: "Invalid request fields" }),
      ),
    ),
  );
