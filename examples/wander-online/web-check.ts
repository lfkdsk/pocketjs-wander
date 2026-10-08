// examples/wander-online/web-check.ts — drive a headless chrome tab running
// the wander-online web build through the Chrome DevTools Protocol and
// assert the acceptance case by STATE, not screenshots:
//
//   1. the web client joins (status "joined", myId assigned),
//   2. it sees the other two clients (online === 3, two remote players) and
//      the expected whole-service population (`allOnline`),
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
//     --out web.png [--wide-out web-wide.png] [--watch] [--expect 3] \
//     [--expect-all 3] [--expect-realm local] [--ticket value] \
//     [--timeout-ms 60000]
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
  allOnline: number;
  rtt: number;
  corrections: number;
  unacked: number;
  realmId: string;
  generatorVersion: number;
  x: number;
  y: number;
  moving: boolean;
  auto: boolean;
  remote: RemotePos[];
}

export interface WebCheckFlags {
  cdp: string;
  page: string;
  out: string;
  /** Optional second 960x544 logical viewport capture. */
  wideOut: string | null;
  watch: boolean;
  expect: number;
  expectAll: number;
  timeoutMs: number;
  expectRealm: string | null;
  /** Auth ticket injected into the page, never included in WEBCHECK output. */
  ticket: string | null;
}

export function parseFlags(args: readonly string[]): WebCheckFlags {
  const get = (name: string, def: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args[i + 1] ?? def) : def;
  };
  const expect = Number(get("expect", "3"));
  return {
    cdp: get("cdp", "http://127.0.0.1:9222"),
    page: get("page", "http://127.0.0.1:9003/wander-online/"),
    out: get("out", "web.png"),
    wideOut: get("wide-out", "") || null,
    watch: args.includes("--watch"),
    expect,
    expectAll: Number(get("expect-all", String(expect))),
    timeoutMs: Number(get("timeout-ms", "60000")),
    expectRealm: get("expect-realm", "") || null,
    ticket: get("ticket", "") || null,
  };
}

const flags = parseFlags(process.argv.slice(2));

const deadline = Date.now() + flags.timeoutMs;
const timeLeft = () => deadline - Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(`web-check: ${message}`);
  process.exit(1);
}

interface RemoteValue {
  type?: unknown;
  value?: unknown;
  description?: unknown;
}

function remoteValueText(value: RemoteValue): string {
  if (typeof value.value === "string") return value.value;
  if (value.value !== undefined) {
    try {
      return JSON.stringify(value.value);
    } catch {
      // Fall through to the protocol description.
    }
  }
  if (typeof value.description === "string") return value.description;
  return typeof value.type === "string" ? value.type : "unknown";
}

/** Turn browser error events into stable diagnostics. Warnings and ordinary
 * console output are intentionally ignored: this gate rejects console.error
 * and uncaught page exceptions, which are the two actionable failure paths. */
export function browserErrorFromEvent(method: string, params: unknown): string | null {
  if (method === "Runtime.consoleAPICalled") {
    const event = params as { type?: unknown; args?: unknown };
    if (event?.type !== "error") return null;
    const args = Array.isArray(event.args) ? event.args as RemoteValue[] : [];
    return `console.error: ${args.map(remoteValueText).join(" ") || "(no message)"}`;
  }
  if (method === "Runtime.exceptionThrown") {
    const event = params as {
      exceptionDetails?: {
        text?: unknown;
        exception?: RemoteValue;
        url?: unknown;
        lineNumber?: unknown;
      };
    };
    const details = event?.exceptionDetails;
    const message = details?.exception ? remoteValueText(details.exception) : details?.text;
    const at = typeof details?.url === "string" && details.url
      ? ` at ${details.url}:${Number(details.lineNumber ?? 0) + 1}`
      : "";
    return `uncaught exception: ${typeof message === "string" ? message : "unknown"}${at}`;
  }
  return null;
}

/** One CDP connection: JSON requests with matching ids over WebSocket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (r: unknown) => void>();
  private readonly listeners = new Map<string, Array<(params: unknown) => void>>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        method?: string;
        params?: unknown;
      };
      if (msg.id !== undefined) {
        const wake = this.pending.get(msg.id);
        if (wake) {
          this.pending.delete(msg.id);
          wake(msg.result);
        }
      } else if (msg.method) {
        for (const listener of this.listeners.get(msg.method) ?? []) listener(msg.params);
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

  on(method: string, listener: (params: unknown) => void): void {
    const listeners = this.listeners.get(method);
    if (listeners) listeners.push(listener);
    else this.listeners.set(method, [listener]);
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

const joinedExpected = (s: PublishedState | null): boolean =>
  s !== null &&
  s.status === "joined" &&
  s.myId > 0 &&
  s.online === flags.expect &&
  s.allOnline === flags.expectAll &&
  (!flags.expectRealm || (s.realmId === flags.expectRealm && s.generatorVersion === 1)) &&
  s.remote.length === flags.expect - 1;

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
    if (s && joinedExpected(s) && posKey(s) !== start) return;
    await sleep(300);
  }
  fail("timed out waiting for anyone to move");
}

async function screenshot(cdp: Cdp, path: string): Promise<void> {
  const res = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
  if (!res.data) fail("screenshot returned no data");
  await Bun.write(path, Buffer.from(res.data, "base64"));
}

async function main(): Promise<void> {
  const cdp = await attach();
  const browserErrors: string[] = [];
  const collectBrowserError = (method: string) => (params: unknown) => {
    const error = browserErrorFromEvent(method, params);
    if (error) browserErrors.push(error);
  };
  cdp.on("Runtime.consoleAPICalled", collectBrowserError("Runtime.consoleAPICalled"));
  cdp.on("Runtime.exceptionThrown", collectBrowserError("Runtime.exceptionThrown"));
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // Install auth before the player page evaluates any script. Local demos
  // use the explicit guest credential; hosted demo-cf can supply a ticket.
  // JSON.stringify keeps ticket contents syntactically inert, and the
  // credential is intentionally absent from the WEBCHECK result below.
  const auth = flags.ticket
    ? { kind: "ticket", ticket: flags.ticket }
    : { kind: "guest", name: "web-demo", color: 1 };
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `globalThis.__onlineAuth=${JSON.stringify(auth)};`,
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
  const joined = await waitFor(
    cdp,
    joinedExpected,
    `join with online === ${flags.expect}, allOnline === ${flags.expectAll}, and ${flags.expect - 1} remotes`,
  );
  await waitForMovement(cdp, joined);

  let restart: { dropped: string; rejoined: PublishedState } | null = null;
  if (flags.watch) {
    // The demo kills the server: the client must drop, then rejoin after
    // the restart and satisfy the same assertions.
    const dropped = await waitFor(cdp, (s) => s !== null && s.status !== "joined", "connection drop (server restart)");
    const rejoined = await waitFor(
      cdp,
      joinedExpected,
      `rejoin with online === ${flags.expect}, allOnline === ${flags.expectAll}, and ${flags.expect - 1} remotes`,
    );
    await waitForMovement(cdp, rejoined);
    restart = { dropped: dropped.status, rejoined };
  }

  await screenshot(cdp, flags.out);
  if (flags.wideOut) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 960,
      height: 544,
      deviceScaleFactor: 3,
      mobile: false,
    });
    await sleep(500);
    await screenshot(cdp, flags.wideOut);
  }
  const final = (await readState(cdp))!;
  if (browserErrors.length > 0) fail(`browser emitted ${browserErrors.join(" | ")}`);
  console.log(
    `WEBCHECK ${JSON.stringify({
      myId: final.myId,
      online: final.online,
      allOnline: final.allOnline,
      remotes: final.remote.length,
      rtt: final.rtt,
      corrections: final.corrections,
      realmId: final.realmId,
      generatorVersion: final.generatorVersion,
      x: final.x,
      y: final.y,
      consoleErrors: browserErrors.length,
      restarted: restart ? { droppedStatus: restart.dropped, myId: restart.rejoined.myId } : null,
    })}`,
  );
  process.exit(0);
}

if (import.meta.main) main().catch((err) => fail(String(err)));
