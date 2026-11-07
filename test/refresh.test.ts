import test from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Fiber } from "effect";
import { makeApplication } from "../src/application.ts";
import { account, quota, applicationLayer } from "./application-fixture.ts";

test(
  "OAuth confirmation cannot reuse an account list captured before completion",
  { timeout: 5000 },
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const accounts = [account("B")];
        let requested = false;
        const app = yield* makeApplication.pipe(
          Effect.provide(
            applicationLayer({
              accounts,
              request: (path) => {
                if (path === "config") return Effect.succeed({ routing: {} });
                assert.equal(path, "get-auth-status?state=connected%2Fstate");
                return Effect.succeed({ status: "ok" });
              },
              quota: (account) =>
                Effect.gen(function* () {
                  if (requested && account.id === "B") {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  return quota(75);
                }),
            }),
          ),
        );
        yield* app.refresh();
        requested = true;
        const full = yield* app.refresh().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        accounts.push(account("A")); // The engine persists a completed OAuth account asynchronously.
        const connected = yield* Effect.gen(function* () {
          assert.deepEqual(yield* app.oauthStatus("connected/state"), {
            status: "ok",
          });
          yield* app.refresh();
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(full);
        yield* Fiber.join(connected);
        const added = (yield* app.snapshot).accounts.find((a) => a.id === "A");
        assert.equal(added?.quota?.windows[0]?.remaining, 75);
      }).pipe(Effect.timeout(3000)),
    );
  },
);

test(
  "an imported account is refreshed after an older full refresh finishes",
  { timeout: 5000 },
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const accounts = [account("B")];
        let requested = false;
        const app = yield* makeApplication.pipe(
          Effect.provide(
            applicationLayer({
              accounts,
              request: (path, options) =>
                path === "config"
                  ? Effect.succeed({ routing: {} })
                  : Effect.sync(() => {
                      assert.equal(path, "auth-files?name=A.json");
                      assert.deepEqual(options, {
                        method: "POST",
                        body: { provider: "codex" },
                      });
                      accounts.push(account("A"));
                      return {};
                    }),
              quota: (account) =>
                Effect.gen(function* () {
                  if (requested && account.id === "B") {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  return quota(75);
                }),
            }),
          ),
        );
        yield* app.refresh();
        requested = true;
        const full = yield* app.refresh().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const imported = yield* app
          .importAccount("A.json", { provider: "codex" })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(full);
        yield* Fiber.join(imported);
        const state = yield* app.snapshot;
        const added = state.accounts.find((a) => a.id === "A");
        assert.equal(added?.quota?.windows[0]?.remaining, 75);
      }).pipe(Effect.timeout(3000)),
    );
  },
);

for (const interrupted of [false, true]) {
  test(
    `a resumed account cannot reuse a full refresh that skipped it (${interrupted ? "interrupted" : "completed"} mutation)`,
    { timeout: 5000 },
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const mutationEntered = yield* Deferred.make<void>();
          const accounts = [{ ...account("A"), disabled: true }, account("B")];
          const calls: string[] = [];
          let requested = false;
          const app = yield* makeApplication.pipe(
            Effect.provide(
              applicationLayer({
                accounts,
                status: (target, disabled) =>
                  Effect.gen(function* () {
                    const index = accounts.findIndex(
                      (a) => a.name === target.name,
                    );
                    const current = accounts[index];
                    assert.ok(current);
                    accounts[index] = { ...current, disabled };
                    if (interrupted) {
                      yield* Deferred.succeed(mutationEntered, undefined);
                      yield* Effect.never;
                    }
                  }),
                quota: (account) =>
                  Effect.gen(function* () {
                    if (requested) {
                      calls.push(account.id);
                      if (account.id === "B") {
                        yield* Deferred.succeed(entered, undefined);
                        yield* Deferred.await(release);
                      }
                    }
                    return quota(75);
                  }),
              }),
            ),
          );
          yield* app.refresh();
          requested = true;
          const full = yield* app.refresh().pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const resume = yield* app
            .setDisabled("A", false)
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const targeted = yield* app.refresh("A").pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(full);
          if (interrupted) {
            yield* Deferred.await(mutationEntered);
            yield* Fiber.interrupt(resume);
          } else {
            yield* Fiber.join(resume);
          }
          yield* Fiber.join(targeted);
          const state = yield* app.snapshot;
          const resumed = state.accounts.find((a) => a.id === "A");
          assert.equal(resumed?.disabled, false);
          assert.equal(resumed?.quota?.windows[0]?.remaining, 75);
          assert.deepEqual(calls, ["B", "A"]);
        }).pipe(Effect.timeout(3000)),
      );
    },
  );
}

for (const { label, ownerScope, waiterScope, expectedCalls, expectedB } of [
  {
    label: "different accounts run their own refresh",
    ownerScope: "A",
    waiterScope: "B",
    expectedCalls: ["A", "B"],
    expectedB: 75,
  },
  {
    label: "a targeted refresh cannot satisfy refresh all",
    ownerScope: "A",
    waiterScope: undefined,
    expectedCalls: ["A", "A", "B"],
    expectedB: 75,
  },
  {
    label: "a full refresh covers a queued account",
    ownerScope: undefined,
    waiterScope: "B",
    expectedCalls: ["A", "B"],
    expectedB: 75,
  },
  {
    label: "matching account refreshes share completed work",
    ownerScope: "A",
    waiterScope: "A",
    expectedCalls: ["A"],
    expectedB: 50,
  },
  {
    label: "matching full refreshes share completed work",
    ownerScope: undefined,
    waiterScope: undefined,
    expectedCalls: ["A", "B"],
    expectedB: 75,
  },
]) {
  test(label, { timeout: 5000 }, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make();
        const release = yield* Deferred.make();
        const calls: string[] = [];
        let requested = false,
          gated = false;
        const app = yield* makeApplication.pipe(
          Effect.provide(
            applicationLayer({
              accounts: [account("A"), account("B")],
              quota: (account) =>
                Effect.gen(function* () {
                  if (requested) {
                    calls.push(account.id);
                    if (!gated) {
                      gated = true;
                      yield* Deferred.succeed(entered, undefined);
                      yield* Deferred.await(release);
                    }
                  }
                  return quota(requested ? 75 : 50);
                }),
            }),
          ),
        );

        yield* app.refresh();
        requested = true;
        const owner = yield* app.refresh(ownerScope).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const waiter = yield* app.refresh(waiterScope).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        yield* Fiber.join(waiter);
        const state = yield* app.snapshot;
        assert.deepEqual(calls, expectedCalls);
        const refreshedB = state.accounts.find((a) => a.id === "B");
        assert.ok(refreshedB?.quota);
        assert.equal(refreshedB.quota.windows[0]?.remaining, expectedB);
        assert.equal(state.connected, true);
      }).pipe(Effect.timeout(3000)),
    );
  });
}

test(
  "a queued refresh completes after its original owner is cancelled",
  { timeout: 5000 },
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let calls = 0,
          saved = 0;
        const app = yield* makeApplication.pipe(
          Effect.provide(
            applicationLayer({
              accounts: [account("one")],
              quota: () =>
                Effect.gen(function* () {
                  calls++;
                  if (calls === 2) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Effect.never;
                  }
                  return quota(calls === 1 ? 80 : 60);
                }),
              saveQuota: () =>
                Effect.sync(() => {
                  saved++;
                }),
            }),
          ),
        );
        yield* app.refresh();
        const owner = yield* app.refresh().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const waiter = yield* app.refresh().pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(owner);
        yield* Fiber.join(waiter);
        const state = yield* app.snapshot;
        assert.equal(calls, 3);
        assert.equal(saved, 2);
        assert.equal(state.accounts[0]?.quota?.windows[0]?.remaining, 60);
        assert.equal(state.connected, true);
        assert.equal(state.refreshing, false);
      }).pipe(Effect.timeout(3000)),
    );
  },
);
