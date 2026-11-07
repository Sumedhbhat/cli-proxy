import test from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Fiber } from "effect";
import { makeApplication } from "../src/application.ts";
import { account, applicationLayer } from "./application-fixture.ts";

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
                    return {
                      windows: [
                        {
                          id: "weekly",
                          label: "Weekly limit",
                          remaining: 75,
                          resetsAt: null,
                        },
                      ],
                      fetchedAt: new Date().toISOString(),
                      availableResets: null,
                      nextResetExpiresAt: null,
                      plan: null,
                    };
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
                  return {
                    windows: [
                      {
                        id: "weekly",
                        label: "Weekly limit",
                        remaining: requested ? 75 : 50,
                        resetsAt: null,
                      },
                    ],
                    fetchedAt: new Date().toISOString(),
                    availableResets: null,
                    nextResetExpiresAt: null,
                    plan: null,
                  };
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
                  return {
                    windows: [
                      {
                        id: "weekly",
                        label: "Weekly limit",
                        remaining: calls === 1 ? 80 : 60,
                        resetsAt: null,
                      },
                    ],
                    fetchedAt: new Date().toISOString(),
                    availableResets: null,
                    nextResetExpiresAt: null,
                    plan: null,
                  };
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
