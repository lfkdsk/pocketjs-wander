// examples/wander-online/server/bots.ts — headless bots for load tests.
//
// Each bot connects, joins, and walks randomly: hold a direction for 1-3 s,
// sometimes stop, turn when stuck. By default bots send INPUT at their
// reference-tick rate (60 Hz) like the v1 client; --batch packs every
// BATCH_SIZE ticks into one INPUT_BATCH (20 Hz wire rate), which is what a
// hosted server with a per-connection message rate limit requires. They
// track RTT from PONG and print a JSON stats line on exit. Used by the
// acceptance demo's 100-bot scene.
//
//   bun run examples/wander-online/server/bots.ts --url ws://127.0.0.1:8080/ws \
//       --count 100 --seconds 45 [--batch] [--github-prefix loadbot]

import { BTN, BATCH_SIZE, MSG, decodeState, decodeWelcome, encodeInput, encodeInputBatch, encodePing } from "../net/protocol.ts";
import { AUTH_PROTOCOL_VERSION } from "../shared/auth.ts";

interface BotOpts {
  url: string;
  count: number;
  seconds: number;
  namePrefix: string;
  batch: boolean;
  /** When set, authenticate each bot through GitHub with
   *  `gho_<prefix><index>` and create its profile on first use. The default
   *  remains guest auth for the standalone --allow-guests server. */
  githubPrefix: string;
}

function parseArgs(argv: string[]): BotOpts {
  const flag = (name: string, def: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? def) : def;
  };
  return {
    url: flag("url", "ws://127.0.0.1:8080/ws"),
    count: Number(flag("count", "100")),
    seconds: Number(flag("seconds", "45")),
    namePrefix: flag("name-prefix", "bot"),
    batch: argv.includes("--batch"),
    githubPrefix: flag("github-prefix", ""),
  };
}

class Bot {
  readonly id: number;
  private ws: WebSocket;
  private seq = 0;
  private mask = 0;
  private nextChange = 0;
  private lastPingAt = 0;
  private pingId = 0;
  private readonly batch: boolean;
  private pending: { seq: number; buttons: number }[] = [];
  private ticket = "";
  rtt = 0;
  corrections = 0;
  lastAck = 0;
  seen = 0;

  constructor(
    url: string,
    private readonly name: string,
    private readonly color: number,
    batch: boolean,
    private readonly githubToken: string,
  ) {
    this.id = 0;
    this.batch = batch;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
    this.ws.addEventListener("open", () => {
      const credential = this.githubToken ? { github: this.githubToken } : { name: this.name, color: this.color };
      this.ws.send(JSON.stringify({ type: "join", v: AUTH_PROTOCOL_VERSION, ...credential }));
    });
    this.ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type === "needCreate" && typeof msg.ticket === "string") {
          this.ticket = msg.ticket;
          this.ws.send(JSON.stringify({
            type: "create",
            v: AUTH_PROTOCOL_VERSION,
            ticket: this.ticket,
            name: this.name,
            look: this.color,
          }));
        } else if (msg.type === "createOk" && this.ticket) {
          this.ws.send(JSON.stringify({ type: "join", v: AUTH_PROTOCOL_VERSION, ticket: this.ticket }));
        }
        return;
      }
      const buf = ev.data as ArrayBuffer;
      const v = new DataView(buf);
      const kind = v.getUint8(0);
      if (kind === MSG.welcome) {
        (this as { id: number }).id = decodeWelcome(buf).you;
      } else if (kind === MSG.state) {
        const st = decodeState(buf);
        this.lastAck = st.ackSeq;
        this.seen = st.entities.length;
      } else if (kind === MSG.pong) {
        this.rtt = Math.max(0, Math.round(now() - v.getUint32(5, true)));
      }
    });
  }

  tick(now: number): void {
    if (this.ws.readyState !== 1) return;
    if (now >= this.nextChange) {
      const dirs = [BTN.up, BTN.right, BTN.down, BTN.left];
      this.mask = Math.random() < 0.15 ? 0 : dirs[Math.floor(Math.random() * 4)]!;
      this.nextChange = now + 1000 + Math.random() * 2000;
    }
    this.seq++;
    if (this.batch) {
      this.pending.push({ seq: this.seq, buttons: this.mask });
      if (this.pending.length >= BATCH_SIZE) {
        this.ws.send(encodeInputBatch(this.pending[0]!.seq, this.pending.map((p) => p.buttons)));
        this.pending.length = 0;
      }
    } else {
      this.ws.send(encodeInput(this.seq, this.mask));
    }
    if (now - this.lastPingAt > 2000) {
      this.lastPingAt = now;
      this.pingId++;
      this.ws.send(encodePing(this.pingId, Math.round(now) % 0x80000000));
    }
  }

  close(): void {
    this.ws.close();
  }
}

export function runBots(opts: BotOpts): Promise<void> {
  return new Promise((resolve) => {
    const bots: Bot[] = [];
    for (let i = 0; i < opts.count; i++) {
      const suffix = `${opts.namePrefix}${i}`;
      const token = opts.githubPrefix ? `gho_${opts.githubPrefix}${i}` : "";
      bots.push(new Bot(opts.url, suffix, i & 0x0f, opts.batch, token));
    }
    const start = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      for (const b of bots) b.tick(now);
      if (now - start >= opts.seconds * 1000) {
        clearInterval(timer);
        const rtts = bots.map((b) => b.rtt).filter((r) => r > 0).sort((a, b) => a - b);
        const p = (q: number) => (rtts.length ? rtts[Math.min(rtts.length - 1, Math.floor(rtts.length * q))]! : 0);
        const seen = bots.map((b) => b.seen);
        console.log(`BOTSTATS ${JSON.stringify({
          count: bots.length,
          rttP50: p(0.5),
          rttP95: p(0.95),
          rttP99: p(0.99),
          seenAvg: Math.round(seen.reduce((a, b) => a + b, 0) / Math.max(1, seen.length) * 10) / 10,
          seenMax: Math.max(0, ...seen),
        })}`);
        for (const b of bots) b.close();
        resolve();
      }
    }, 1000 / 60);
  });
}

if (import.meta.main) {
  await runBots(parseArgs(process.argv.slice(2)));
  process.exit(0);
}
