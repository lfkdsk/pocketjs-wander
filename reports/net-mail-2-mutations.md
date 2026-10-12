# NET-MAIL-2 mutation evidence

Each mutation ran from server commit `cd3757f` in its own detached disposable
worktree. Only `src/auth.ts` in that worktree was changed; the delivery
worktrees were never mutated. Commands used Bun 1.3.14 and a 60-second timeout.

## 1. Replayed request delivers a second card

Mutation: disable the successful-receipt early return so the retry follows the
new-send path again.

```text
bun test tests/auth-do.test.ts --test-name-pattern "same request id survives reconstruction"

expected id: first postcard id
received id: a different postcard id
expected recipient total/unread: 1/1
received recipient total/unread: 2/2
expected replayed/writes: true/0
received replayed/writes: false/7

0 pass
54 filtered out
1 fail
exit 1
```

The idempotency test therefore detects a response-loss retry that performs a
second delivery.

## 2. Replay consumes daily quota again

Mutation: increment the sender's daily counter inside the otherwise unchanged
receipt-replay branch.

```text
bun test tests/auth-do.test.ts --test-name-pattern "same request id survives reconstruction"

expected dailyRemaining: 4
received dailyRemaining: 3

0 pass
54 filtered out
1 fail
exit 1
```

The stable replay and single-delivery assertions pass first; the independent
quota assertion catches the second charge.

## 3. Alarm leaves expired rows behind

Mutation: replace the due expiry batch's row deletion with an empty delete.

```text
bun test tests/auth-do.test.ts --test-name-pattern "alarm actively removes expired postcard rows"

expected rows containing postcard id: []
received: expiry index, inbox row, outbox row

0 pass
54 filtered out
1 fail
exit 1
```

The account remains inactive throughout the test, so this red result depends
on active alarm cleanup rather than a mailbox/status call.

## 4. Reply bypasses the bilateral friendship check

Mutation: keep the bilateral check for direct sends but skip it for an opaque
reply target.

```text
bun test tests/auth-do.test.ts --test-name-pattern "a reply resolves an opaque inbox id"

expected: { ok: false, reason: "not-friends" }
received: { ok: true, replayed: false, storageRowWrites: 7 }

0 pass
54 filtered out
1 fail
exit 1
```

The reply test therefore rejects using a retained, already-read card after the
friendship has been removed.

All four required single-fault mutations were killed by behavior-specific
assertions, with no compile-only or unrelated failure.

PASS
