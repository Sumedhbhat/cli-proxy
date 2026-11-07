import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, FiberSet, Layer, Schedule, Schema } from "effect";
import http from "node:http";
import type { Duplex } from "node:stream";
import { AppConfig, ConfigLive } from "./config.ts";
import { Engine, EngineLive } from "./engine.ts";
import { StorageLive } from "./storage.ts";
import { Application, ApplicationLive } from "./application.ts";
import { loadAssets } from "./assets.ts";
import { inferencePath, makeGateway, scopeRequest } from "./gateway.ts";
import {
  decodeBody,
  etagMatches,
  json,
  requestURL,
  send,
  validOrigin,
} from "./http.ts";
import { InputError, JsonObject, record } from "./domain.ts";

const RefreshInput = Schema.Struct({ id: Schema.optional(Schema.String) });
const SettingsInput = Schema.Struct({ scheduler: Schema.Boolean });
const AccountInput = Schema.Struct({
  id: Schema.String,
  disabled: Schema.Boolean,
});
const Provider = Schema.Literals(["claude", "codex"]);
const OAuthInput = Schema.Struct({ provider: Provider });
const CallbackInput = Schema.Struct({
  provider: Provider,
  redirect_url: Schema.String,
});
const ImportInput = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[\w.@+-]{1,160}\.json$/)),
  credential: JsonObject,
});

export const serve = Effect.gen(function* () {
  const config = yield* AppConfig;
  const app = yield* Application;
  const engine = yield* Engine;
  const gateway = yield* makeGateway;
  const { assets, indexHTML } = yield* loadAssets;
  const run = yield* FiberSet.makeRuntime<never, void, never>();
  const route = Effect.fn("HTTP.route")(function* (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const provider = scopeRequest(req);
    const url = yield* requestURL(req);
    const path = url.pathname;
    if (inferencePath(path)) {
      yield* gateway.proxy(req, res, provider);
      return;
    }
    if (path === "/healthz") {
      json(res, 200, { status: "ok", demo: config.demo });
      return;
    }
    if (path.startsWith("/api/")) {
      if (req.method !== "GET" && !validOrigin(req))
        return yield* new InputError({
          status: 403,
          message: "Cross-origin request rejected",
        });
      if (path === "/api/state" && req.method === "GET") {
        json(res, 200, yield* app.snapshot);
        return;
      }
      if (path === "/api/refresh" && req.method === "POST") {
        const data = yield* decodeBody(req, RefreshInput);
        if (
          data.id &&
          !(yield* app.snapshot).accounts.some((a) => a.id === data.id)
        )
          return yield* new InputError({
            status: 400,
            message: "Unknown account",
          });
        yield* app.refresh(data.id);
        const state = yield* app.snapshot;
        json(res, 200, { ok: state.connected, error: state.refreshError });
        return;
      }
      if (path === "/api/settings" && req.method === "PUT") {
        const data = yield* decodeBody(req, SettingsInput);
        yield* app.setScheduler(data.scheduler);
        json(res, 200, {
          ok: true,
          warning: (yield* app.snapshot).schedulerError,
        });
        return;
      }
      if (path === "/api/account" && req.method === "PATCH") {
        const data = yield* decodeBody(req, AccountInput);
        yield* app.setDisabled(data.id, data.disabled);
        json(res, 200, { ok: true });
        return;
      }
      if (path === "/api/oauth/start" && req.method === "POST") {
        if (config.demo)
          return yield* new InputError({
            status: 409,
            message:
              "OAuth is available in live mode. Run npm run setup first.",
          });
        const { provider } = yield* decodeBody(req, OAuthInput);
        const data = record(
          yield* engine.request(
            `${provider === "claude" ? "anthropic" : provider}-auth-url?is_webui=true`,
          ),
        );
        json(res, 200, { url: data.url, state: data.state });
        return;
      }
      if (path === "/api/oauth/status" && req.method === "GET") {
        if (config.demo)
          return yield* new InputError({
            status: 409,
            message: "OAuth requires live mode",
          });
        json(
          res,
          200,
          yield* app.oauthStatus(url.searchParams.get("state") || ""),
        );
        return;
      }
      if (path === "/api/oauth/callback" && req.method === "POST") {
        if (config.demo)
          return yield* new InputError({
            status: 400,
            message: "Provider and callback URL required in live mode",
          });
        const data = yield* decodeBody(req, CallbackInput);
        json(
          res,
          200,
          yield* engine.request("oauth-callback", {
            method: "POST",
            body: data,
          }),
        );
        return;
      }
      if (path === "/api/import" && req.method === "POST") {
        const { name, credential } = yield* decodeBody(req, ImportInput);
        if (config.demo)
          return yield* new InputError({
            status: 409,
            message: "Credential import is available in live mode",
          });
        yield* app.importAccount(name, credential);
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { error: "Unknown endpoint" });
      return;
    }
    if (
      !["GET", "HEAD"].includes(req.method || "") ||
      (path !== "/" && !assets[path])
    ) {
      json(res, 404, { error: "Not found" });
      return;
    }
    if (path === "/") {
      const state = JSON.stringify(yield* app.snapshot).replace(
        /</g,
        "\\u003c",
      );
      send(
        res,
        200,
        {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
        Buffer.from(
          indexHTML.replace(
            "</body>",
            () =>
              `<script id="initial-state" type="application/json">${state}</script>\n</body>`,
          ),
        ),
      );
      return;
    }
    const asset = assets[path];
    const pinned =
      path.startsWith("/fonts/") || url.searchParams.get("v") === asset.hash;
    const headers = {
      "Content-Type": asset.type,
      "Cache-Control": pinned
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      ETag: asset.etag,
    };
    if (etagMatches(req.headers["if-none-match"], asset.etag)) {
      res.writeHead(304, { ...headers, Vary: "Accept-Encoding" });
      res.end();
      return;
    }
    send(res, 200, headers, asset.body, asset);
  });
  const handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const fiber = run(
      route(req, res).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (error instanceof InputError && error.status === 413)
              res.setHeader("Connection", "close");
            if (!res.headersSent)
              json(res, error instanceof InputError ? error.status : 502, {
                error:
                  error instanceof InputError
                    ? error.message
                    : "CLIProxyAPI engine unavailable",
              });
            else res.destroy();
          }),
        ),
        Effect.catchDefect(() =>
          Effect.sync(() => {
            if (!res.headersSent)
              json(res, 500, { error: "Internal server error" });
            else res.destroy();
          }),
        ),
      ),
    );
    // Once a client leaves, its engine requests and body readers stop too.
    res.once("close", () => {
      if (!res.writableFinished)
        run(Fiber.interrupt(fiber).pipe(Effect.asVoid));
    });
  };
  const sockets = new Set<Duplex>();
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const server = http.createServer(handle);
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.on("upgrade", (req, socket, head) => {
        socket.on("error", () => {
          socket.destroy();
        });
        const fiber = run(
          Effect.gen(function* () {
            scopeRequest(req);
            const { pathname } = yield* requestURL(req);
            if (pathname !== "/v1/responses" || !validOrigin(req)) {
              socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
              return;
            }
            yield* gateway.upgrade(req, socket, head);
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                if (error instanceof InputError)
                  socket.end(
                    "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n",
                  );
                else socket.destroy();
              }),
            ),
            Effect.catchDefect(() =>
              Effect.sync(() => {
                socket.destroy();
              }),
            ),
          ),
        );
        socket.once("close", () => {
          run(Fiber.interrupt(fiber).pipe(Effect.asVoid));
        });
      });
      return server;
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        for (const socket of sockets) socket.destroy();
      }),
  );
  yield* Effect.callback<void, InputError>((resume) => {
    server.once("error", (error) =>
      resume(
        Effect.fail(
          new InputError({
            status: 500,
            message: `Could not listen: ${error.message}`,
          }),
        ),
      ),
    );
    server.listen(config.port, "127.0.0.1", () => resume(Effect.void));
  });
  console.log(
    `CLI Proxy ${config.demo ? "(demo)" : ""}: http://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  yield* app
    .refresh()
    .pipe(
      Effect.repeat(
        Schedule.spaced(
          config.demo
            ? 60000
            : (yield* app.snapshot).settings.intervalSeconds * 1000,
        ),
      ),
      Effect.forkScoped,
    );
  yield* Effect.never;
});
const infrastructure = Layer.mergeAll(ConfigLive, NodeServices.layer);
const services = Layer.mergeAll(EngineLive, StorageLive).pipe(
  Layer.provideMerge(infrastructure),
);
export const Live = ApplicationLive.pipe(Layer.provideMerge(services));
NodeRuntime.runMain(serve.pipe(Effect.scoped, Effect.provide(Live)));
