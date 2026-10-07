// examples/wander-online/web-check.ts — drive a headless chrome tab running
// the wander-online web build through the Chrome DevTools Protocol and
// assert the acceptance case by STATE, not screenshots:
//
//   1. the web client joins (status "joined", myId assigned),
//   2. it sees the other two clients (online === 3, two remote players),
//   3. someone moves (local or a remote player changes position).
//
// Then it writes a 3x screenshot and prints one WEBCHECK JSON line.
//
// Watch mode (--watch) additionally waits for the connection to drop (a
// server restart in the demo) and for a fresh rejoin that satisfies the
// same three assertions — the restart-recovery phase.
//
//   bun run examples/wander-online/web-check.ts \
//     --cdp http://127.0.0.1:9222 --page http://127.0.0.1:9003/wander-online/ \
//     --out web.png [--watch] [--expect 3] [--timeout-ms 60000]
//
// Exit 0 on success, 1 on any failed assertion or timeout. The DevTools
// endpoint is chrome's own loopback listener; this script never opens a
// non-loopback socket.

interface RemotePos {
  id: number;
  x: number;
  y: number;
}

interface PublishedState {
  status: string;
  myId: number;
  online: number;
  rtt: number;
  corrections: number;
  unacked: number;
  x: number;
  y: number;
  moving: boolean;
  auto: boolean;
  remote: RemotePos[];
}

const flags = (() => {
  const args = process.argv.slice(2);
  const get = (name: string, def: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args[i + 1] ?? def) : def;
  };
  return {
    cdp: get("cdp", "http://127.0.0.1:9222"),
    page: get("page", "http://127.0.0.1:9003/wander-online/"),
    out: get("out", "web.png"),
    watch: args.includes("--watch"),
    expect: Number(get("expect", "3")),
    timeoutMs: Number(get("timeout-ms", "60000")),
  };
})();

const deadline = Date.now() + flags.timeoutMs;
const timeLeft = () => deadline - Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(`web-check: ${message}`);
  process.exit(1);
}

/** One CDP connection: JSON requests with matching ids over WebSocket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (r: unknown) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown };
      if (msg.id !== undefined) {
        const wake = this.pending.get(msg.id);
        if (wake) {
          this.pending.delete(msg.id);
          wake(msg.result);
        }
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error(`cdp connect failed: ${url}`)));
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
      }, 10_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

interface Target {
  type: string;
  url?: string;
  webSocketDebuggerUrl: string;
}

async function attach(): Promise<Cdp> {
  // Chrome may still be starting: retry the target list.
  let last = "";
  while (timeLeft() > 0) {
    try {
      const res = await fetch(`${flags.cdp}/json`);
      const targets = (await res.json()) as Target[];
      // Prefer the blank tab Chrome was started with: newer headless Chrome
      // also lists internal pages, and navigating one of those never answers.
      // Without a blank tab, open a fresh one.
      let page = targets.find((t) => t.type === "page" && t.url === "about:blank" && t.webSocketDebuggerUrl);
      if (!page) {
        const created = await fetch(`${flags.cdp}/json/new?about:blank`, { method: "PUT" });
        if (created.ok) page = (await created.json()) as Target;
      }
      if (page?.webSocketDebuggerUrl) return Cdp.connect(page.webSocketDebuggerUrl);
      last = "no page target yet";
    } catch (err) {
      last = String(err);
    }
    await sleep(250);
  }
  fail(`chrome devtools endpoint never appeared at ${flags.cdp} (${last})`);
}

async function readState(cdp: Cdp): Promise<PublishedState | null> {
  const res = (await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify(globalThis.__onlineState || null)",
    returnByValue: true,
  })) as { result?: { value?: string } };
  const raw = res.result?.value;
  return raw ? (JSON.parse(raw) as PublishedState) : null;
}

const joinedThree = (s: PublishedState | null): boolean =>
  s !== null && s.status === "joined" && s.myId > 0 && s.online === flags.expect && s.remote.length === flags.expect - 1;

const posKey = (s: PublishedState): string =>
  `${s.x},${s.y}|` + s.remote.map((r) => `${r.id}:${r.x},${r.y}`).join(";");

/** Poll until `pred` holds, sampling every 300 ms. */
async function waitFor(cdp: Cdp, pred: (s: PublishedState | null) => boolean, what: string): Promise<PublishedState> {
  let last: PublishedState | null = null;
  while (timeLeft() > 0) {
    last = await readState(cdp);
    if (last && pred(last)) return last;
    await sleep(300);
  }
  fail(`timed out waiting for ${what}; last state: ${JSON.stringify(last)}`);
}

/** Poll until some position (local or either remote) changed since `first`. */
async function waitForMovement(cdp: Cdp, first: PublishedState): Promise<void> {
  const start = posKey(first);
  while (timeLeft() > 0) {
    const s = await readState(cdp);
    if (s && joinedThree(s) && posKey(s) !== start) return;
    await sleep(300);
  }
  fail("timed out waiting for anyone to move");
}

async function screenshot(cdp: Cdp): Promise<void> {
  const res = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
  if (!res.data) fail("screenshot returned no data");
  await Bun.write(flags.out, Buffer.from(res.data, "base64"));
}

async function main(): Promise<void> {
  const cdp = await attach();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // The acceptance demo talks only to the loopback server started with
  // --allow-guests. Install its explicit development credential before the
  // player page evaluates any script; production pages never do this.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: 'globalThis.__onlineAuth={kind:"guest",name:"web-demo",color:1};',
  });
  // 480x272 at 3x density, matching the desktop demo captures.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 480,
    height: 272,
    deviceScaleFactor: 3,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: flags.page });

  // 1. join + 2. see the other clients + 3. movement.
  const joined = await waitFor(cdp, joinedThree, `join with online === ${flags.expect} and ${flags.expect - 1} remotes`);
  await waitForMovement(cdp, joined);

  let restart: { dropped: string; rejoined: PublishedState } | null = null;
  if (flags.watch) {
    // The demo kills the server: the client must drop, then rejoin after
    // the restart and satisfy the same assertions.
    const dropped = await waitFor(cdp, (s) => s !== null && s.status !== "joined", "connection drop (server restart)");
    const rejoined = await waitFor(cdp, joinedThree, `rejoin with online === ${flags.expect} and ${flags.expect - 1} remotes`);
    await waitForMovement(cdp, rejoined);
    restart = { dropped: dropped.status, rejoined };
  }

  await screenshot(cdp);
  const final = (await readState(cdp))!;
  console.log(
    `WEBCHECK ${JSON.stringify({
      myId: final.myId,
      online: final.online,
      remotes: final.remote.length,
      rtt: final.rtt,
      corrections: final.corrections,
      restarted: restart ? { droppedStatus: restart.dropped, myId: restart.rejoined.myId } : null,
    })}`,
  );
  process.exit(0);
}

main().catch((err) => fail(String(err)));
