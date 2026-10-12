# Daily realm goal mutation checks

Each mutation ran in a separate disposable copy. A check passes here only when
the deliberately broken implementation makes its focused test fail.

## Nondeterministic goal generation

Mutation: mix `Math.random()` into the realm hash used by
`generateDailyGoal`.

Command:

```text
bun test tests/wander-online-daily-goal.test.ts -t "same realm seed and day are stable while dates, realms and seeds vary"
```

Result: exit 1, `0 pass`, `1 fail`. The second call for the same seed, realm,
and day produced a different `goalId`, required count, offer, target, and town;
the failure was `expect(received).toEqual(expected)` at the same-input stability
assertion.

## Cross-midnight contribution attribution

Mutation: resolve the authoritative UTC day from a clock shifted one minute
backward, making a fact at the new day's boundary remain on the prior day.

Command:

```text
bun test tests/room-do.test.ts -t "the midnight boundary switches online sockets and attributes one fact to each UTC day"
```

Result: exit 1, `0 pass`, `1 fail`. After the clock crossed midnight, the test
expected a new-day zero snapshot followed by new-day progress 1 with history
`[20005, 20004]`; it received no new daily frames (`[]`).

## Duplicate completion broadcast

Mutation: broadcast the authoritative completion frame a second time whenever
`completedNow` is true.

Command:

```text
bun test tests/room-do.test.ts -t "three players share progress, completion broadcasts once, and the festival persists"
```

Result: exit 1, `0 pass`, `1 fail`. Every socket's completion-frame count was
2 while the assertion requires exactly 1 (`Expected length: 1`, `Received
length: 2`).

## Same-account sibling cancellation

Mutation: stop synchronizing an incarnation's READY claim across its live
same-account sessions, recreating the behavior where only the submitting
socket can clear its in-memory claim.

Command:

```text
bun test tests/room-do.test.ts -t "a sibling session that never sent READY can cancel the incarnation's claim"
```

Result: exit 1, `0 pass`, `1 fail`. Session B sent cancellation, but session
A retained its READY structure instead of becoming null; the failure was
`expect(received).toBeNull()`.

## Cooperative offer comparison

Mutation: remove `offerRx` and `offerRy` equality from the hosted arena's
partner filter while leaving the shared destination comparison intact.

Command:

```text
bun test tests/room-do.test.ts -t "different cooperative offers to one target remain separate"
```

Result: exit 1, `0 pass`, `1 fail`. The first courier's distinct errand was
incorrectly completed (`null`) instead of remaining `{ rx: 1, ry: -5 }`.

All five required mutations were killed by their focused checks.
