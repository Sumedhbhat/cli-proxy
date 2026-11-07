import { Effect, Redacted, Schema } from "effect";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { AppConfig } from "./config.ts";
import { Application } from "./application.ts";
import { modelProvider, nearestResetInfo } from "./quota.ts";
import { codexLimitError } from "./codex-limit.ts";
import { filterModelCatalog } from "./model-catalog.ts";
import { JsonObject, record, records, TransportError } from "./domain.ts";
import { equal, json, readBounded } from "./http.ts";

export type Provider = "claude" | "codex";
export function scopeRequest(req: http.IncomingMessage): Provider | undefined {
  const match = /^\/(codex|claude)(\/v1(?:\/|\?|$).*)/.exec(req.url || "/");
  if (match) {
    req.url = match[2];
    return match[1] as Provider;
  }
}
export const inferencePath = (path: string) =>
  /^\/v1\/(models|messages(?:\/count_tokens)?|chat\/completions|completions|responses(?:\/.*)?)$/.test(
    path,
  );
export const authorized = (req: http.IncomingMessage, key: string) =>
  equal(req.headers.authorization, `Bearer ${key}`) ||
  equal(req.headers["x-api-key"], key);
function requestModel(body: string): string | undefined {
  try {
    const model = record(JSON.parse(body)).model;
    return typeof model === "string" ? model : undefined;
  } catch {
    return /"model"\s*:\s*"([^"\\]{1,200})"/.exec(body.slice(0, 65536))?.[1];
  }
}
const parseObject = (bytes: Buffer) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
    bytes.toString(),
  );
const completed = (res: http.ServerResponse | Duplex) =>
  Effect.callback<void>((resume) => {
    if (res.destroyed || ("writableFinished" in res && res.writableFinished)) {
      resume(Effect.void);
      return;
    }
    const done = () => resume(Effect.void);
    res.once("close", done);
    res.once("finish", done);
    return Effect.sync(() => {
      res.off("close", done);
      res.off("finish", done);
    });
  });
const pipeResponse = (
  response: http.IncomingMessage,
  res: http.ServerResponse,
) =>
  Effect.callback<void, TransportError>((resume) => {
    const fail = (cause: Error) =>
      resume(
        Effect.fail(
          new TransportError({ message: "Upstream stream failed", cause }),
        ),
      );
    const done = () => resume(Effect.void);
    response.once("error", fail);
    res.once("error", fail);
    res.once("finish", done);
    res.once("close", done);
    response.pipe(res);
    return Effect.sync(() => {
      response.off("error", fail);
      res.off("error", fail);
      res.off("finish", done);
      res.off("close", done);
    });
  });

export const makeGateway = Effect.gen(function* () {
  const config = yield* AppConfig;
  const app = yield* Application;
  const apiKey = Redacted.value(config.apiKey);
  const catalogOwners = Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(new URL("/v1/models", config.engineURL), {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "User-Agent": "cli-proxy",
              "Accept-Encoding": "identity",
            },
            signal: controller.signal,
            redirect: "error",
          }),
        catch: (cause) =>
          new TransportError({
            message: "Model ownership lookup failed",
            cause,
          }),
      });
      if (!response.ok || !response.body)
        return yield* new TransportError({
          message: "Model ownership lookup failed",
        });
      const payload = yield* readBounded(response.body).pipe(
        Effect.flatMap(parseObject),
        Effect.mapError(
          (cause) =>
            new TransportError({
              message: "Invalid model ownership catalog",
              cause,
            }),
        ),
      );
      if (!Array.isArray(payload.data))
        return yield* new TransportError({
          message: "Invalid model ownership catalog",
        });
      return new Map(
        records(payload.data).map((model) => [
          String(model.id),
          model.owned_by,
        ]),
      );
    }),
  ).pipe(Effect.timeout(10000));

  const forward = (
    req: http.IncomingMessage,
    res: http.ServerResponse | Duplex,
    provider?: Provider,
    upgradeHead?: Buffer,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestURL = new URL(req.url || "/", "http://localhost");
        const path = requestURL.pathname;
        // Absolute-form and network-path request targets cannot change the upstream origin.
        const target = new URL(
          requestURL.pathname + requestURL.search,
          config.engineURL,
        );
        const headers: http.OutgoingHttpHeaders = {
          ...req.headers,
          host: target.host,
        };
        const filterModels =
          req.method === "GET" && path === "/v1/models" && provider;
        if (filterModels) {
          headers["accept-encoding"] = "identity";
          delete headers["if-none-match"];
          delete headers["if-modified-since"];
        }
        delete headers.cookie;
        delete headers["x-management-key"];
        delete headers["proxy-authorization"];
        for (const name of Object.keys(headers))
          if (name.startsWith("x-forwarded-")) delete headers[name];
        headers.authorization = `Bearer ${apiKey}`;
        if (headers["x-api-key"]) headers["x-api-key"] = apiKey;
        const transport = target.protocol === "https:" ? https : http;
        const upstream = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const request = transport.request(target, {
              method: req.method,
              headers,
            });
            // Keep an error listener through finalization, including errors after response headers.
            request.on("error", () => {});
            request.setTimeout(300000, () =>
              request.destroy(new Error("Upstream timeout")),
            );
            return request;
          }),
          (request) =>
            Effect.sync(() => {
              request.destroy();
            }),
        );
        const prefix: Buffer[] = [];
        let prefixSize = 0;
        const capture = (chunk: Buffer) => {
          if (prefixSize < 2 * 1024 * 1024) {
            prefix.push(chunk.subarray(0, 2 * 1024 * 1024 - prefixSize));
            prefixSize += chunk.length;
          }
        };
        if (upgradeHead === undefined) {
          req.on("data", capture);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              req.off("data", capture);
              req.unpipe(upstream);
            }),
          );
        }
        type Opened =
          | {
              readonly type: "response";
              readonly response: http.IncomingMessage;
            }
          | {
              readonly type: "upgrade";
              readonly response: http.IncomingMessage;
              readonly socket: Duplex;
              readonly head: Buffer;
            };
        const start = Date.now();
        const opened = yield* Effect.callback<Opened, TransportError>(
          (resume) => {
            const onResponse = (response: http.IncomingMessage) =>
              resume(Effect.succeed({ type: "response", response }));
            const onUpgrade = (
              response: http.IncomingMessage,
              socket: Duplex,
              head: Buffer,
            ) =>
              resume(
                Effect.succeed({ type: "upgrade", response, socket, head }),
              );
            const onError = (cause: Error) =>
              resume(
                Effect.fail(
                  new TransportError({
                    message: "CLIProxyAPI engine unavailable",
                    cause,
                  }),
                ),
              );
            upstream.once("response", onResponse);
            upstream.once("upgrade", onUpgrade);
            upstream.once("error", onError);
            if (upgradeHead !== undefined) upstream.end();
            else req.pipe(upstream);
            return Effect.sync(() => {
              upstream.off("response", onResponse);
              upstream.off("upgrade", onUpgrade);
              upstream.off("error", onError);
            });
          },
        );
        if (opened.type === "upgrade") {
          const { response, socket, head } = opened;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              socket.destroy();
            }),
          );
          socket.on("error", () => {
            res.destroy();
          });
          res.on("error", () => {
            socket.destroy();
          });
          socket.on("close", () => {
            res.destroy();
          });
          res.write(
            `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(
              response.headers,
            )
              .filter(([k]) => k !== "set-cookie")
              .map(([k, v]) => `${k}: ${v}`)
              .join("\r\n")}\r\n\r\n`,
          );
          if (head.length) res.write(head);
          if (upgradeHead?.length) socket.write(upgradeHead);
          socket.pipe(res);
          res.pipe(socket);
          yield* app.log("request", "WebSocket connected", { status: 101 });
          yield* completed(res);
          return;
        }
        const { response } = opened;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            response.destroy();
          }),
        );
        if (upgradeHead !== undefined) {
          res.end(
            `HTTP/1.1 ${response.statusCode} Upstream rejected upgrade\r\nConnection: close\r\n\r\n`,
          );
          return;
        }
        const output = res as http.ServerResponse;
        const outputHeaders = { ...response.headers };
        delete outputHeaders["set-cookie"];
        if (filterModels && response.statusCode === 200) {
          const payload = yield* parseObject(yield* readBounded(response));
          const owners = Array.isArray(payload.models)
            ? yield* catalogOwners
            : new Map<string, unknown>();
          const filtered = yield* Effect.try({
            try: () => filterModelCatalog(payload, provider, owners),
            catch: (cause) =>
              new TransportError({
                message: "Invalid upstream model catalog",
                cause,
              }),
          });
          for (const key of [
            "content-length",
            "transfer-encoding",
            "etag",
            "content-encoding",
          ])
            delete outputHeaders[key];
          outputHeaders["cache-control"] = "no-store";
          output.writeHead(200, outputHeaders);
          output.end(JSON.stringify(filtered));
          yield* completed(output);
          return;
        }
        if (response.statusCode === 429) {
          const model = requestModel(Buffer.concat(prefix).toString());
          const family =
            modelProvider(model) ??
            (path.startsWith("/v1/responses") ? "codex" : null);
          const resetInfo =
            family === "claude" && model
              ? nearestResetInfo((yield* app.snapshot).accounts, model)
              : null;
          const reset = resetInfo?.resetsAt;
          if (family === "codex" || reset) {
            const bytes = yield* readBounded(response);
            const payload = yield* parseObject(bytes).pipe(
              Effect.orElseSucceed(() => null),
            );
            const error = record(payload?.error);
            const editable =
              payload &&
              typeof error.message === "string" &&
              !outputHeaders["content-encoding"];
            const limit =
              editable && family === "codex"
                ? yield* app.codexLimit(model)
                : null;
            let replacement: JsonObject | null = null;
            if (limit) {
              replacement = codexLimitError(limit, error);
              delete outputHeaders["x-codex-active-limit"];
              Object.assign(outputHeaders, limit.headers, {
                "x-ratelimit-reset": limit.resetsAt,
              });
              yield* app.log("limit", "Codex usage limit reported to client", {
                status: 429,
                resetsAt: limit.resetsAt,
              });
            } else if (editable && reset) {
              replacement = {
                ...error,
                message: `${error.message} Nearest Claude account reset: ${reset}.`,
                resets_at: reset,
              };
              outputHeaders["retry-after"] = String(
                Math.max(1, Math.ceil((Date.parse(reset) - Date.now()) / 1000)),
              );
              outputHeaders["x-ratelimit-reset"] = reset;
              if (resetInfo.rateLimitType) {
                outputHeaders["anthropic-ratelimit-unified-status"] =
                  "rejected";
                outputHeaders["anthropic-ratelimit-unified-reset"] = String(
                  Math.ceil(Date.parse(reset) / 1000),
                );
                outputHeaders[
                  "anthropic-ratelimit-unified-representative-claim"
                ] = resetInfo.rateLimitType;
              }
            }
            if (replacement) {
              delete outputHeaders["content-length"];
              delete outputHeaders["transfer-encoding"];
            }
            output.writeHead(429, outputHeaders);
            output.end(
              replacement
                ? JSON.stringify({ ...payload, error: replacement })
                : bytes,
            );
            yield* completed(output);
            return;
          }
        }
        output.writeHead(response.statusCode || 502, outputHeaders);
        yield* pipeResponse(response, output);
        yield* app.log("request", `${req.method} ${path}`, {
          status: response.statusCode,
          durationMs: Date.now() - start,
        });
      }),
    ).pipe(
      Effect.tapError(() => app.log("error", "Upstream connection failed")),
    );
  const proxy = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    provider?: Provider,
  ) =>
    Effect.gen(function* () {
      if (config.demo || !authorized(req, apiKey)) {
        json(res, config.demo ? 503 : 401, {
          error: {
            message: config.demo
              ? "Demo mode does not forward inference"
              : "Invalid proxy API key",
          },
        });
        return;
      }
      yield* forward(req, res, provider);
    });
  const upgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) =>
    Effect.gen(function* () {
      if (config.demo || !authorized(req, apiKey)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const limit = yield* app.codexLimit();
      if (limit) {
        const body = JSON.stringify({ error: codexLimitError(limit) });
        const headers = {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Retry-After": Math.max(
            1,
            Math.ceil((Date.parse(limit.resetsAt) - Date.now()) / 1000),
          ),
          "X-Ratelimit-Reset": limit.resetsAt,
          ...limit.headers,
          Connection: "close",
        };
        socket.end(
          `HTTP/1.1 429 Too Many Requests\r\n${Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n")}\r\n\r\n${body}`,
        );
        yield* app.log("limit", "Codex usage limit reported to client", {
          status: 429,
          resetsAt: limit.resetsAt,
        });
        return;
      }
      yield* forward(req, socket, undefined, head);
    });
  return { proxy, upgrade };
});
