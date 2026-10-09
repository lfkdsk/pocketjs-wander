// Reproducible input-batching A/B measurement against the real loopback
// v4 server and OnlineClient. The three-tick arm clears only the WELCOME4
// capability bit in its measured transport; the server, predictor,
// reconciliation and interpolation paths are otherwise identical.

import type {
  PocketSocket,
  SocketCloseEvent,
  SocketError,
} from "@pocketjs/framework/socket";
import { OnlineClient, type SocketFactory } from "../examples/wander-online/net/client.ts";
import {
  BTN,
  MSG,
  WELCOME4_FLAG_INPUT_BATCH_6,
} from "../examples/wander-online/net/protocol.ts";
import { RealmPredictor } from "../examples/wander-online/net/realm-predict.ts";
import { startServer } from "../examples/wander-online/server/server.ts";
import { bunSocketFactory } from "../tests/lib/bun-pocket-socket.ts";

const FRAME_HZ = 60;
const FRAME_MS = 1000 / FRAME_HZ;
const SIMULATED_ONE_WAY_MS = 40;
const STEADY_MS = 12_000;
const FEEL_TRIALS = 8;
const MONTH_SECONDS_31_DAYS = 31 * 24 * 60 * 60;
const PLAYERS_PER_ROOM = 32;
const MESSAGES_PER_BILLED_REQUEST = 20;
const GB_SECONDS_PER_AWAKE_SECOND = 0.128;
const INCLUDED_REQUESTS = 1_000_000;
const INCLUDED_GB_SECONDS = 400_000;
const REQUEST_DOLLARS_PER_MILLION = 0.15;
const DURATION_DOLLARS_PER_MILLION = 12.5;
const WORKERS_PAID_BASE_DOLLARS = 5;

type BatchTicks = 3 | 6;
type SentKind = "input" | "inputBatch" | "ping" | "command" | "text" | "other";

interface Position {
  x: number;
  y: number;
}

interface TrafficSnapshot {
  elapsedMs: number;
  sent: Record<SentKind, number>;
  sentBytes: number;
  inputTicks: number;
  inputBatchTicks: number[];
  state4Snapshots: number;
  cadencePerSecond: {
    inputBatch: number;
    ping: number;
    totalSteadyInbound: number;
  };
  windowMessagesPerSecond: number;
}

class TrafficProbe {
  private active = false;
  private startedAt = 0;
  private stoppedAt = 0;
  private readonly counts: Record<SentKind, number> = {
    input: 0,
    inputBatch: 0,
    ping: 0,
    command: 0,
    text: 0,
    other: 0,
  };
  private sentBytes = 0;
  private inputTicks = 0;
  private readonly batchTicks: number[] = [];
  private state4Snapshots = 0;
  private readonly times: Record<SentKind, number[]> = {
    input: [],
    inputBatch: [],
    ping: [],
    command: [],
    text: [],
    other: [],
  };

  start(): void {
    this.active = true;
    this.startedAt = performance.now();
    this.stoppedAt = 0;
    for (const key of Object.keys(this.counts) as SentKind[]) {
      this.counts[key] = 0;
      this.times[key].length = 0;
    }
    this.sentBytes = 0;
    this.inputTicks = 0;
    this.batchTicks.length = 0;
    this.state4Snapshots = 0;
  }

  stop(): TrafficSnapshot {
    this.stoppedAt = performance.now();
    this.active = false;
    const elapsedMs = this.stoppedAt - this.startedAt;
    const inputBatch = cadence(this.times.inputBatch);
    const ping = cadence(this.times.ping);
    const messageCount = Object.values(this.counts).reduce((sum, count) => sum + count, 0);
    return {
      elapsedMs: round(elapsedMs),
      sent: { ...this.counts },
      sentBytes: this.sentBytes,
      inputTicks: this.inputTicks,
      inputBatchTicks: [...this.batchTicks],
      state4Snapshots: this.state4Snapshots,
      cadencePerSecond: {
        inputBatch: round(inputBatch),
        ping: round(ping),
        totalSteadyInbound: round(inputBatch + ping),
      },
      windowMessagesPerSecond: round(messageCount * 1000 / elapsedMs),
    };
  }

  sent(data: string | Uint8Array | ArrayBuffer): void {
    if (!this.active) return;
    const now = performance.now();
    if (typeof data === "string") {
      this.record("text", now, new TextEncoder().encode(data).byteLength);
      return;
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const kind = bytes[0];
    if (kind === MSG.input) {
      this.inputTicks++;
      this.record("input", now, bytes.byteLength);
    } else if (kind === MSG.inputBatch) {
      const ticks = bytes[5] ?? 0;
      this.inputTicks += ticks;
      this.batchTicks.push(ticks);
      this.record("inputBatch", now, bytes.byteLength);
    } else if (kind === MSG.ping) {
      this.record("ping", now, bytes.byteLength);
    } else if (kind === MSG.command) {
      this.record("command", now, bytes.byteLength);
    } else {
      this.record("other", now, bytes.byteLength);
    }
  }

  received(data: string | Uint8Array): void {
    if (!this.active || typeof data === "string") return;
    if (data[0] === MSG.state4) this.state4Snapshots++;
  }

  private record(kind: SentKind, now: number, bytes: number): void {
    this.counts[kind]++;
    this.times[kind].push(now);
    this.sentBytes += bytes;
  }
}

/** Wrap the real Bun WebSocket adapter so the A/B harness can count the
 * server's inbound messages and emulate an old v4 WELCOME in the baseline. */
function measuredSocketFactory(probe: TrafficProbe, batchTicks: BatchTicks): SocketFactory {
  return (url: string): PocketSocket => {
    const inner = bunSocketFactory(url);
    const outer: PocketSocket = {
      get url() {
        return inner.url;
      },
      get protocol() {
        return inner.protocol;
      },
      get readyState() {
        return inner.readyState;
      },
      onOpen: undefined,
      onMessage: undefined,
      onClose: undefined,
      onError: undefined,
      send(data) {
        probe.sent(data);
        return inner.send(data);
      },
      close(code?: number, reason?: string) {
        inner.close(code, reason);
      },
    };
    inner.onOpen = () => outer.onOpen?.();
    inner.onError = (error: SocketError) => outer.onError?.(error);
    inner.onClose = (event: SocketCloseEvent) => outer.onClose?.(event);
    inner.onMessage = (data: string | Uint8Array) => {
      let forwarded = data;
      if (batchTicks === 3 && typeof data !== "string" && data[0] === MSG.welcome4) {
        const copy = data.slice();
        copy[28] = (copy[28] ?? 0) & ~WELCOME4_FLAG_INPUT_BATCH_6;
        forwarded = copy;
      }
      probe.received(forwarded);
      outer.onMessage?.(forwarded);
    };
    return outer;
  };
}

class FramePump {
  driverMask = 0;
  frames = 0;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly driver: OnlineClient,
    private readonly observer: OnlineClient,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    const origin = performance.now();
    let nextFrame = 1;
    while (this.running) {
      const waitMs = origin + nextFrame * FRAME_MS - performance.now();
      if (waitMs > 0) await Bun.sleep(waitMs);
      if (!this.running) break;
      this.driver.onFrame(this.driverMask, FRAME_HZ, 0);
      this.observer.onFrame(0, FRAME_HZ, 0);
      this.frames++;
      nextFrame++;
    }
  }
}

function cadence(times: readonly number[]): number {
  if (times.length < 2) return 0;
  return (times.length - 1) * 1000 / (times[times.length - 1]! - times[0]!);
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[index]!);
}

function summary(samples: readonly number[]): { samples: number[]; median: number; p95: number; max: number } {
  return {
    samples: samples.map((sample) => round(sample)),
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: round(Math.max(...samples)),
  };
}

function localPosition(client: OnlineClient): Position {
  const predictor = client.predictor;
  if (!predictor) throw new Error("client has no predictor");
  return { x: predictor.current.move.px, y: predictor.current.move.py };
}

function remotePosition(observer: OnlineClient, id: number): Position | null {
  const pos = observer.interp.renderAt(id, performance.now());
  return pos ? { x: pos.x, y: pos.y } : null;
}

function changed(a: Position, b: Position, epsilon = 0.25): boolean {
  return Math.abs(a.x - b.x) > epsilon || Math.abs(a.y - b.y) > epsilon;
}

const DIRECTIONS = [
  { mask: BTN.right, dx: 1, dy: 0 },
  { mask: BTN.down, dx: 0, dy: 1 },
  { mask: BTN.left, dx: -1, dy: 0 },
  { mask: BTN.up, dx: 0, dy: -1 },
] as const;

function safeDirection(client: OnlineClient, offset = 0): number {
  const predictor = client.predictor;
  if (!(predictor instanceof RealmPredictor)) throw new Error("measurement requires a v4 realm predictor");
  const move = predictor.current.move;
  for (let i = 0; i < DIRECTIONS.length; i++) {
    const direction = DIRECTIONS[(i + offset) % DIRECTIONS.length]!;
    const collision = predictor.world.collisionAt(move.tx + direction.dx, move.ty + direction.dy);
    if (collision.ready && !collision.blocked) return direction.mask;
  }
  throw new Error(`no passable neighbour at ${move.tx},${move.ty}`);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function feelTrials(driver: OnlineClient, observer: OnlineClient, pump: FramePump): Promise<{
  localVisibleMs: ReturnType<typeof summary>;
  remoteVisibleMs: ReturnType<typeof summary>;
}> {
  const localSamples: number[] = [];
  const remoteSamples: number[] = [];
  for (let trial = 0; trial < FEEL_TRIALS; trial++) {
    pump.driverMask = 0;
    await Bun.sleep(620 + (trial % 3) * 37);
    const localBefore = localPosition(driver);
    const remoteBefore = remotePosition(observer, driver.myId);
    if (!remoteBefore) throw new Error("observer lost the driver before a feel trial");
    const mask = safeDirection(driver, trial);
    const startedAt = performance.now();
    pump.driverMask = mask;
    let localAt = 0;
    let remoteAt = 0;
    const deadline = startedAt + 1_500;
    while (performance.now() < deadline && (localAt === 0 || remoteAt === 0)) {
      const now = performance.now();
      if (localAt === 0 && changed(localBefore, localPosition(driver))) localAt = now;
      const remote = remotePosition(observer, driver.myId);
      if (remoteAt === 0 && remote && changed(remoteBefore, remote)) remoteAt = now;
      await Bun.sleep(1);
    }
    pump.driverMask = 0;
    if (localAt === 0 || remoteAt === 0) {
      throw new Error(`feel trial ${trial + 1} did not become visible (local=${localAt !== 0}, remote=${remoteAt !== 0})`);
    }
    localSamples.push(localAt - startedAt);
    remoteSamples.push(remoteAt - startedAt);
  }
  return {
    localVisibleMs: summary(localSamples),
    remoteVisibleMs: summary(remoteSamples),
  };
}

async function steadyDrive(driver: OnlineClient, pump: FramePump, durationMs: number): Promise<void> {
  const deadline = performance.now() + durationMs;
  let phase = 0;
  while (performance.now() < deadline) {
    pump.driverMask = phase % 2 === 0 ? safeDirection(driver, phase / 2) : 0;
    phase++;
    await Bun.sleep(Math.min(200, Math.max(1, deadline - performance.now())));
  }
  pump.driverMask = 0;
}

async function measureArm(batchTicks: BatchTicks): Promise<Record<string, unknown>> {
  const server = startServer({
    port: 0,
    seed: 0x5eed_0001,
    hz: 20,
    broadcastHz: 10,
    aoi: 16,
    simLatency: SIMULATED_ONE_WAY_MS,
    webRoot: "",
    allowGuests: true,
    realmEpoch: 0xe000 + batchTicks,
  });
  const driverProbe = new TrafficProbe();
  const observerProbe = new TrafficProbe();
  const driver = new OnlineClient(`ws://127.0.0.1:${server.port}/ws`, {
    name: `driver-${batchTicks}`,
    color: 1,
    auth: { kind: "guest" },
    socketFactory: measuredSocketFactory(driverProbe, batchTicks),
  });
  const observer = new OnlineClient(`ws://127.0.0.1:${server.port}/ws`, {
    name: `observer-${batchTicks}`,
    color: 2,
    auth: { kind: "guest" },
    socketFactory: measuredSocketFactory(observerProbe, batchTicks),
  });
  const pump = new FramePump(driver, observer);
  try {
    await waitFor(() => driver.status === "joined" && observer.status === "joined", "both clients to join");
    pump.start();
    await waitFor(
      () => driver.online === 2 && observer.online === 2 && remotePosition(observer, driver.myId) !== null,
      "both clients to see one another",
    );
    // Warm the ping cadence, authoritative snapshots and interpolation ring.
    await Bun.sleep(2_500);
    const feel = await feelTrials(driver, observer, pump);
    pump.driverMask = 0;
    await Bun.sleep(700);

    const correctionsBefore = [driver.corrections, observer.corrections];
    const frameBefore = pump.frames;
    driverProbe.start();
    observerProbe.start();
    const steadyStartedAt = performance.now();
    await steadyDrive(driver, pump, STEADY_MS);
    // Drain delayed snapshots while continuing the normal idle input stream.
    await Bun.sleep(700);
    const steadyElapsedMs = performance.now() - steadyStartedAt;
    const traffic = [driverProbe.stop(), observerProbe.stop()];
    const correctionCounts = [
      driver.corrections - correctionsBefore[0]!,
      observer.corrections - correctionsBefore[1]!,
    ];
    const perClient = traffic.map((snapshot, index) => ({
      role: index === 0 ? "driver" : "observer",
      ...snapshot,
      corrections: correctionCounts[index],
      correctionRatePerState4: snapshot.state4Snapshots === 0
        ? 0
        : round(correctionCounts[index]! / snapshot.state4Snapshots),
    }));
    const meanInbound = perClient.reduce(
      (sum, row) => sum + row.cadencePerSecond.totalSteadyInbound,
      0,
    ) / perClient.length;
    return {
      batchTicks,
      clients: 2,
      simulatedOneWayLatencyMs: SIMULATED_ONE_WAY_MS,
      interpolationDelayMs: 100,
      feel,
      rttMsAtEnd: { driver: driver.rtt, observer: observer.rtt },
      steady: {
        targetDriveMs: STEADY_MS,
        elapsedIncludingDrainMs: round(steadyElapsedMs),
        frames: pump.frames - frameBefore,
        perClient,
        meanSteadyInboundMessagesPerClientSecond: round(meanInbound),
      },
    };
  } finally {
    pump.driverMask = 0;
    await pump.stop();
    driver.stop();
    observer.stop();
    server.close();
    await Bun.sleep(50);
  }
}

function monthlyCost(rate: number): Array<Record<string, number>> {
  const rows: Array<Record<string, number>> = [];
  for (let rooms = 1; rooms <= 4; rooms++) {
    const players = rooms * PLAYERS_PER_ROOM;
    const billedRequests = rate * players * MONTH_SECONDS_31_DAYS / MESSAGES_PER_BILLED_REQUEST;
    const gbSeconds = rooms * MONTH_SECONDS_31_DAYS * GB_SECONDS_PER_AWAKE_SECOND;
    const requestOverage = Math.max(0, billedRequests - INCLUDED_REQUESTS)
      / 1_000_000 * REQUEST_DOLLARS_PER_MILLION;
    const durationOverage = Math.max(0, gbSeconds - INCLUDED_GB_SECONDS)
      / 1_000_000 * DURATION_DOLLARS_PER_MILLION;
    rows.push({
      rooms,
      players,
      billedRequests: Math.round(billedRequests),
      gbSeconds: round(gbSeconds),
      requestOverageDollars: round(requestOverage, 2),
      durationOverageDollars: round(durationOverage, 2),
      totalWithBaseDollars: round(WORKERS_PAID_BASE_DOLLARS + requestOverage + durationOverage, 2),
    });
  }
  return rows;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function gitHead(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : "unknown";
}

async function main(): Promise<void> {
  const output = arg("out");
  if (!output) throw new Error("usage: bun run tools/net-world-e-measure.ts --out <result.json>");
  const baseline = await measureArm(3);
  const batched = await measureArm(6);
  const baselineRate = Number(
    (baseline.steady as Record<string, unknown>).meanSteadyInboundMessagesPerClientSecond,
  );
  const batchedRate = Number(
    (batched.steady as Record<string, unknown>).meanSteadyInboundMessagesPerClientSecond,
  );
  const baselineFeel = baseline.feel as Record<string, { median: number; p95: number }>;
  const batchedFeel = batched.feel as Record<string, { median: number; p95: number }>;
  const result = {
    schema: "net-world-e-measure/v1",
    generatedAt: new Date().toISOString(),
    wanderHead: gitHead(),
    method: {
      transport: "real loopback Bun WebSocket server plus two OnlineClient instances",
      baseline: "WELCOME4 six-tick capability bit cleared in the measured transport only",
      simulatedOneWayLatencyMs: SIMULATED_ONE_WAY_MS,
      serverTickHz: 20,
      broadcastHz: 10,
      clientFrameHz: FRAME_HZ,
      interpolationDelayMs: 100,
      correctionDenominator: "received STATE4 snapshots during the steady window",
      messageRate: "sum of inter-arrival cadences for INPUT_BATCH and application PING",
    },
    runs: { baseline3: baseline, batched6: batched },
    comparison: {
      steadyInboundReductionPercent: round((1 - batchedRate / baselineRate) * 100),
      localMedianDeltaMs: round(batchedFeel.localVisibleMs.median - baselineFeel.localVisibleMs.median),
      localP95DeltaMs: round(batchedFeel.localVisibleMs.p95 - baselineFeel.localVisibleMs.p95),
      remoteMedianDeltaMs: round(batchedFeel.remoteVisibleMs.median - baselineFeel.remoteVisibleMs.median),
      remoteP95DeltaMs: round(batchedFeel.remoteVisibleMs.p95 - baselineFeel.remoteVisibleMs.p95),
    },
    costModel: {
      scope: "capacity model with the application breaker raised; steady player input/PING plus continuously occupied Room duration only",
      exclusions: "upgrades, control-plane DO calls, storage, account-shared usage and taxes",
      assumptions: {
        monthSeconds: MONTH_SECONDS_31_DAYS,
        playersPerRoom: PLAYERS_PER_ROOM,
        messagesPerBilledRequest: MESSAGES_PER_BILLED_REQUEST,
        gbSecondsPerAwakeSecond: GB_SECONDS_PER_AWAKE_SECOND,
        includedRequests: INCLUDED_REQUESTS,
        includedGbSeconds: INCLUDED_GB_SECONDS,
        requestDollarsPerMillion: REQUEST_DOLLARS_PER_MILLION,
        durationDollarsPerMillion: DURATION_DOLLARS_PER_MILLION,
        workersPaidBaseDollars: WORKERS_PAID_BASE_DOLLARS,
      },
      baselineMeasuredMessagesPerClientSecond: baselineRate,
      batchedMeasuredMessagesPerClientSecond: batchedRate,
      baseline: monthlyCost(baselineRate),
      batched: monthlyCost(batchedRate),
    },
  };
  await Bun.write(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${output}`);
  console.log(`steady inbound: ${baselineRate}/s -> ${batchedRate}/s per client`);
  console.log(`remote visible median: ${baselineFeel.remoteVisibleMs.median} ms -> ${batchedFeel.remoteVisibleMs.median} ms`);
}

await main();
