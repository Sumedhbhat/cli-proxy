import test from "node:test";
import assert from "node:assert/strict";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { downloadEngineRelease } from "../src/release-download.ts";

const version = "8.0.59";
const asset = `CLIProxyAPI_${version}_linux_amd64.tar.gz`;
const release = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}`;
const api = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases";
const metadata = {
  assets: [
    { name: asset, id: 123 },
    { name: "checksums.txt", id: 456 },
  ],
};

test("release downloads use the normal URLs when they work", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(url.startsWith(`${release}/`));
    return new Response(url.endsWith("checksums.txt") ? "checksums" : "engine");
  });
  const result = await Effect.runPromise(downloadEngineRelease(version, asset));
  assert.equal(result.archive.toString(), "engine");
  assert.equal(result.checksums.toString(), "checksums");
});

test("a 504 switches to API assets and retries transient asset failures", async (t) => {
  let archiveAttempts = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.startsWith(`${release}/`))
      return new Response(null, { status: 504 });
    if (url === `${api}/tags/v${version}`) return Response.json(metadata);
    assert.equal(
      init.headers && new Headers(init.headers).get("accept"),
      "application/octet-stream",
    );
    if (url === `${api}/assets/456`) return new Response("checksums");
    assert.equal(url, `${api}/assets/123`);
    if (++archiveAttempts === 1) return new Response(null, { status: 503 });
    return new Response("engine");
  });
  const result = await Effect.runPromise(downloadEngineRelease(version, asset));
  assert.equal(result.archive.toString(), "engine");
  assert.equal(result.checksums.toString(), "checksums");
  assert.equal(archiveAttempts, 2);
});

test("temporary API failures stop after bounded retries and identify the failing URL", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.startsWith(`${release}/`))
      return new Response(null, { status: 504 });
    assert.equal(url, `${api}/tags/v${version}`);
    attempts++;
    return new Response(null, { status: 502 });
  });
  const error = await Effect.runPromise(
    downloadEngineRelease(version, asset).pipe(Effect.flip),
  );
  assert.equal(error._tag, "InputError");
  assert.match(error.message, /HTTP 502/);
  assert.ok(error.message.includes(`${api}/tags/v${version}`));
  assert.equal(attempts, 3);
});

test("a missing release fails without retrying or changing download routes", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response(null, { status: 404 });
  });
  const error = await Effect.runPromise(
    downloadEngineRelease(version, asset).pipe(Effect.flip),
  );
  assert.match(error.message, /HTTP 404/);
  assert.ok(calls.every((url) => url.startsWith(`${release}/`)));
  assert.ok(calls.length <= 2);
});

test("an API response missing the requested asset fails clearly", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url.startsWith(`${release}/`)
      ? new Response(null, { status: 504 })
      : Response.json({ assets: [] }),
  );
  const error = await Effect.runPromise(
    downloadEngineRelease(version, asset).pipe(Effect.flip),
  );
  assert.ok(error.message.includes(asset));
  assert.match(error.message, /not found/);
});

test("the archive deadline aborts a stalled body and recovers through the API", async (t) => {
  const started = Promise.withResolvers<void>();
  let aborted = false;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url === `${release}/${asset}`) {
      const response = new Response();
      response.arrayBuffer = () =>
        new Promise<ArrayBuffer>((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
          started.resolve();
        });
      return response;
    }
    if (url === `${api}/tags/v${version}`) return Response.json(metadata);
    return new Response(url.endsWith("/123") ? "engine" : "checksums");
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* downloadEngineRelease(version, asset).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust("5 minutes");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  assert.equal(aborted, true);
  assert.equal(result.archive.toString(), "engine");
});
