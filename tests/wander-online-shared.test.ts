// tests/wander-online-shared.test.ts — pure logic shared between the Bun
// area server and the Cloudflare Worker (server repo): admission limits,
// the monthly budget breaker, the billing conversion, the Origin
// whitelist, the batched INPUT codec and the shared snapshot builder.
// Everything runs under a fake clock; no sockets, no hosts.
import { describe, expect, test } from "bun:test";
import { Arena } from "../examples/wander-online/server/area.ts";
import { BTN, MSG, decodeInputBatch, decodeState, encodeInputBatch } from "../examples/wander-online/net/protocol.ts";
import { snapshotFor } from "../examples/wander-online/shared/snapshot.ts";
import {
  CLOSE_REASON,
  IdleTracker,
  IpCounter,
  SlidingWindow,
  checkOrigin,
  pickFilling,
  pickLeastLoaded,
} from "../examples/wander-online/shared/limits.ts";
import {
  BILLED_MEMORY_MB,
  DEFAULT_BUDGET_FRACTION,
  DEFAULT_PLAN,
  MESSAGES_PER_REQUEST,
  MonthLedger,
  billUsage,
  emptyLedger,
  monthKey,
} from "../examples/wander-online/shared/meter.ts";

const ORIGIN_POLICY = { pagesOrigin: "https://lfkdsk.github.io", allowLoopback: true };

describe("shared: origin whitelist", () => {
  test("no Origin (desktop client) is allowed", () => {
    expect(checkOrigin(null, ORIGIN_POLICY)).toBe(true);
    expect(checkOrigin(undefined, ORIGIN_POLICY)).toBe(true);
    expect(checkOrigin("", ORIGIN_POLICY)).toBe(true);
  });
  test("the Pages origin is allowed, with or without a trailing slash", () => {
    expect(checkOrigin("https://lfkdsk.github.io", ORIGIN_POLICY)).toBe(true);
    expect(checkOrigin("https://lfkdsk.github.io/", ORIGIN_POLICY)).toBe(true);
  });
  test("loopback origins are allowed on any port", () => {
    expect(checkOrigin("http://127.0.0.1:8080", ORIGIN_POLICY)).toBe(true);
    expect(checkOrigin("http://localhost:9003", ORIGIN_POLICY)).toBe(true);
    expect(checkOrigin("http://[::1]:8080", ORIGIN_POLICY)).toBe(true);
  });
  test("loopback is denied when the policy disallows it", () => {
    expect(checkOrigin("http://127.0.0.1:8080", { ...ORIGIN_POLICY, allowLoopback: false })).toBe(false);
  });
  test("foreign and non-http origins are denied", () => {
    expect(checkOrigin("https://evil.example.com", ORIGIN_POLICY)).toBe(false);
    expect(checkOrigin("http://lfkdsk.github.io", ORIGIN_POLICY)).toBe(false); // wrong scheme
    expect(checkOrigin("https://lfkdsk.github.io.evil.com", ORIGIN_POLICY)).toBe(false);
    expect(checkOrigin("file:///etc/passwd", ORIGIN_POLICY)).toBe(false);
    expect(checkOrigin("not a url", ORIGIN_POLICY)).toBe(false);
  });
});

describe("shared: sliding-window rate limit", () => {
  test("30 messages in one second pass, the 31st is refused", () => {
    let t = 1000;
    const w = new SlidingWindow(30, 1000, () => t);
    for (let i = 0; i < 30; i++) expect(w.hit()).toBe(true);
    expect(w.hit()).toBe(false);
    expect(w.size).toBe(30);
  });
  test("the window slides: a hit past the window is allowed again", () => {
    let t = 1000;
    const w = new SlidingWindow(30, 1000, () => t);
    for (let i = 0; i < 30; i++) w.hit();
    expect(w.hit()).toBe(false);
    t += 1001;
    expect(w.hit()).toBe(true);
  });
  test("partial slide: only the expired portion frees up", () => {
    let t = 0;
    const w = new SlidingWindow(3, 1000, () => t);
    w.hit(); w.hit(); // t=0
    t = 500;
    w.hit(); // third
    expect(w.hit()).toBe(false);
    t = 1001; // the two t=0 hits expire
    expect(w.hit()).toBe(true);
    expect(w.hit()).toBe(true); // the t=500 hit still counts, two slots free
    expect(w.hit()).toBe(false); // back at the cap
  });
});

describe("shared: room selection", () => {
  test("picks the least-loaded room with a free slot", () => {
    expect(pickLeastLoaded([0, 0, 0, 0], 32)).toBe(0);
    expect(pickLeastLoaded([5, 2, 9, 3], 32)).toBe(1);
    expect(pickLeastLoaded([32, 31, 32, 32], 32)).toBe(1);
  });
  test("returns -1 when every room is full", () => {
    expect(pickLeastLoaded([32, 32, 32, 32], 32)).toBe(-1);
    expect(pickLeastLoaded([1], 1)).toBe(-1);
  });

  test("pickFilling packs players into the fullest room with space", () => {
    expect(pickFilling([0, 0, 0, 0], 32)).toBe(0); // the first player opens room 0
    expect(pickFilling([1, 0, 0, 0], 32)).toBe(0); // the second joins them
    expect(pickFilling([5, 2, 9, 3], 32)).toBe(2);
    expect(pickFilling([32, 4, 32, 7], 32)).toBe(3); // full rooms are skipped
    expect(pickFilling([32, 32, 32, 32], 32)).toBe(-1);
    expect(pickFilling([3, 3, 0, 0], 32)).toBe(0); // ties: lowest index
  });
});

describe("shared: per-IP connection accounting", () => {
  test("acquires up to the cap, then refuses; releases free the slot", () => {
    const c = new IpCounter();
    expect(c.acquire("1.2.3.4", 2)).toBe(true);
    expect(c.acquire("1.2.3.4", 2)).toBe(true);
    expect(c.acquire("1.2.3.4", 2)).toBe(false);
    expect(c.acquire("5.6.7.8", 2)).toBe(true); // other IP unaffected
    c.release("1.2.3.4");
    expect(c.acquire("1.2.3.4", 2)).toBe(true);
  });
  test("release below zero is a no-op and drops the IP", () => {
    const c = new IpCounter();
    c.release("9.9.9.9");
    expect(c.size).toBe(0);
    expect(c.count("9.9.9.9")).toBe(0);
  });
  test("round-trips through JSON for durable storage", () => {
    const c = new IpCounter();
    c.acquire("1.1.1.1", 4);
    c.acquire("1.1.1.1", 4);
    c.acquire("2.2.2.2", 4);
    const c2 = IpCounter.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
    expect(c2.count("1.1.1.1")).toBe(2);
    expect(c2.count("2.2.2.2")).toBe(1);
    expect(IpCounter.fromJSON({ bad: -3, also: "x" }).size).toBe(0);
  });
});

describe("shared: idle tracking", () => {
  test("expired players are reported once and forgotten", () => {
    let t = 0;
    const idle = new IdleTracker(() => t);
    idle.touch(1);
    idle.touch(2);
    t = 100_000;
    idle.touch(3); // 3 is fresh
    t = 300_001; // 300 s timeout: 1 and 2 expire
    const expired = idle.takeExpired(300_000).sort();
    expect(expired).toEqual([1, 2]);
    expect(idle.size).toBe(1);
    expect(idle.takeExpired(300_000)).toEqual([]);
  });
});

describe("shared: billing conversion", () => {
  test("inbound messages convert 20:1 with ceil, upgrades count fully", () => {
    expect(billUsage({ inboundMessages: 0, upgrades: 0, awakeSeconds: 0 })).toEqual({ requests: 0, gbSeconds: 0 });
    expect(billUsage({ inboundMessages: 1, upgrades: 0, awakeSeconds: 0 }).requests).toBe(1); // ceil(1/20)
    expect(billUsage({ inboundMessages: 20, upgrades: 0, awakeSeconds: 0 }).requests).toBe(1);
    expect(billUsage({ inboundMessages: 21, upgrades: 0, awakeSeconds: 0 }).requests).toBe(2);
    expect(billUsage({ inboundMessages: 0, upgrades: 3, awakeSeconds: 0 }).requests).toBe(3);
    expect(billUsage({ inboundMessages: 40, upgrades: 2, awakeSeconds: 0 }).requests).toBe(4);
  });
  test("awake seconds bill at 128 MB -> 0.125 GB-s each", () => {
    expect(billUsage({ inboundMessages: 0, upgrades: 0, awakeSeconds: 1 }).gbSeconds).toBeCloseTo(128 / 1024);
    expect(billUsage({ inboundMessages: 0, upgrades: 0, awakeSeconds: 60 }).gbSeconds).toBeCloseTo(60 * (128 / 1024));
    expect(BILLED_MEMORY_MB).toBe(128);
    expect(MESSAGES_PER_REQUEST).toBe(20);
  });
});

describe("shared: monthly ledger", () => {
  test("accumulates billed usage within a month", () => {
    const l = new MonthLedger();
    l.record(new Date("2026-10-15T12:00:00Z"), billUsage({ inboundMessages: 100, upgrades: 4, awakeSeconds: 120 }));
    l.record(new Date("2026-10-20T12:00:00Z"), billUsage({ inboundMessages: 100, upgrades: 1, awakeSeconds: 60 }));
    expect(l.month).toBe("2026-10");
    expect(l.requests).toBe(5 + Math.ceil(200 / 20));
    expect(l.gbSeconds).toBeCloseTo(180 * (128 / 1024));
  });
  test("a new UTC month resets the counter", () => {
    const l = new MonthLedger();
    l.record(new Date("2026-10-31T23:59:00Z"), { requests: 999, gbSeconds: 999 });
    l.record(new Date("2026-11-01T00:00:00Z"), { requests: 7, gbSeconds: 3 });
    expect(l.month).toBe("2026-11");
    expect(l.requests).toBe(7);
    expect(l.gbSeconds).toBe(3);
  });
  test("roll() resets on a month boundary without adding usage", () => {
    const l = new MonthLedger(emptyLedger("2026-10"));
    l.record(new Date("2026-10-31T23:59:00Z"), { requests: 999, gbSeconds: 999 });
    expect(l.roll(new Date("2026-10-31T23:59:30Z"))).toBe(false); // same month: untouched
    expect(l.requests).toBe(999);
    expect(l.roll(new Date("2026-11-01T00:00:00Z"))).toBe(true); // new month: reset
    expect(l.month).toBe("2026-11");
    expect(l.requests).toBe(0);
    expect(l.gbSeconds).toBe(0);
    expect(l.roll(new Date("2026-11-01T00:00:30Z"))).toBe(false); // already rolled: no-op
  });
  test("a fresh ledger rolls on first use, so /check works before any /report", () => {
    const l = new MonthLedger();
    expect(l.month).toBe("");
    expect(l.roll(new Date("2026-11-01T00:00:00Z"))).toBe(true);
    expect(l.month).toBe("2026-11");
    expect(l.overBudget(0.8, { requests: 100, gbSeconds: 100 })).toEqual({ requests: false, gbSeconds: false });
  });
  test("monthKey is UTC, not local time", () => {
    expect(monthKey(new Date("2026-01-01T00:30:00+02:00"))).toBe("2025-12"); // 22:30 UTC prev day
    expect(monthKey(new Date("2026-12-31T23:00:00-05:00"))).toBe("2027-01"); // 04:00 UTC next day
  });
  test("overBudget trips at BUDGET_FRACTION of the plan, per metric", () => {
    const l = new MonthLedger(emptyLedger("2026-10"));
    const plan = { requests: 100, gbSeconds: 100 };
    l.record(new Date("2026-10-01T00:00:00Z"), { requests: 79, gbSeconds: 0 });
    expect(l.overBudget(0.8, plan)).toEqual({ requests: false, gbSeconds: false });
    l.record(new Date("2026-10-01T00:00:00Z"), { requests: 1, gbSeconds: 0 }); // 80 = 0.8 * 100
    expect(l.overBudget(0.8, plan)).toEqual({ requests: true, gbSeconds: false });
    l.record(new Date("2026-10-01T00:00:00Z"), { requests: 0, gbSeconds: 80 });
    expect(l.overBudget(0.8, plan)).toEqual({ requests: true, gbSeconds: true });
  });
  test("defaults match the Workers Paid inclusion and 0.8 breaker", () => {
    expect(DEFAULT_PLAN.requests).toBe(1_000_000);
    expect(DEFAULT_PLAN.gbSeconds).toBe(400_000);
    expect(DEFAULT_BUDGET_FRACTION).toBe(0.8);
  });
  test("round-trips through JSON for durable storage", () => {
    const l = new MonthLedger();
    l.record(new Date("2026-10-15T00:00:00Z"), { requests: 42, gbSeconds: 17 });
    const l2 = new MonthLedger(JSON.parse(JSON.stringify(l.toJSON())) as never);
    expect(l2.month).toBe("2026-10");
    expect(l2.requests).toBe(42);
    expect(l2.gbSeconds).toBe(17);
  });
});

describe("shared: batched INPUT codec", () => {
  test("round-trips up to BATCH_SIZE buttons", () => {
    const b = encodeInputBatch(7, [BTN.up, BTN.down, 0]);
    expect(new DataView(b).getUint8(0)).toBe(MSG.inputBatch);
    const d = decodeInputBatch(b)!;
    expect(d.firstSeq).toBe(7);
    expect(d.buttons).toEqual([BTN.up, BTN.down, 0]);
  });
  test("rejects truncated, empty and over-capacity batches", () => {
    expect(decodeInputBatch(new ArrayBuffer(3))).toBeNull();
    const empty = new ArrayBuffer(6);
    new DataView(empty).setUint8(5, 0);
    expect(decodeInputBatch(empty)).toBeNull();
    // count byte above BATCH_SIZE is refused even when bytes are present.
    const over = new ArrayBuffer(6 + 4 * 2);
    const dv = new DataView(over);
    dv.setUint8(0, MSG.inputBatch);
    dv.setUint8(5, 4);
    expect(decodeInputBatch(over)).toBeNull();
    // encode caps at BATCH_SIZE.
    expect(decodeInputBatch(encodeInputBatch(1, [1, 2, 3, 4]))!.buttons.length).toBe(3);
  });
});

describe("shared: snapshot builder", () => {
  test("builds a decodable STATE acked at the recipient's watermark", () => {
    const arena = new Arena({ seed: 0x5eed_0001, hz: 20 });
    const me = arena.add("me", 1);
    arena.pushInput(me, 1, BTN.right);
    arena.step();
    arena.indexPlayers();
    const buf = snapshotFor(arena, me, 16, 1, 7);
    const st = decodeState(buf);
    expect(st.frame).toBe(arena.frame);
    expect(st.ackSeq).toBe(me.lastSeq);
    expect(st.entities.some((e) => e.id === me.id)).toBe(true);
    expect(st.roomOnline).toBe(1);
    expect(st.allOnline).toBe(7);
  });

  test("keeps legacy STATE byte shape when population is omitted", () => {
    const arena = new Arena({ seed: 0x5eed_0001, hz: 20 });
    const me = arena.add("legacy", 1);
    arena.indexPlayers();
    const st = decodeState(snapshotFor(arena, me, 16));
    expect(st.roomOnline).toBeNull();
    expect(st.allOnline).toBeNull();
  });
});

describe("shared: close-reason tokens", () => {
  test("the six documented tokens exist", () => {
    expect(Object.values(CLOSE_REASON).sort().join(",")).toBe("full,idle,ip,origin,rate,rest");
  });
});
