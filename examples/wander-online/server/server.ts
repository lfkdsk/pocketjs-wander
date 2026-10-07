// examples/wander-online/server/server.ts — Bun area server: authoritative
// reducer + AOI broadcast.
//
// One process owns one Arena (a frozen wander window). Clients connect over
// WebSocket, send JOIN once, then INPUT at their reference-tick rate (one
// per predicted tick, each carrying a sequence number). The server queues
// each player's inputs and folds them through the kit's stepSession at the
// host rate (20 Hz folds 3 reference ticks per frame), and broadcasts each
// player their interest set (Chebyshev radius) as full idempotent snapshots
// at broadcastHz. Every snapshot carries ackSeq: the last INPUT sequence
// applied for that recipient, which is the client's reconciliation
// watermark. PING/PONG measures RTT.
//
// The server binds 127.0.0.1 only: this demo never listens on a
// non-loopback interface (asserted by the tests).
//
//   bun run examples/wander-online/server/server.ts --port 8080 --seed 2654435769 \
//       --hz 20 --broadcast-hz 10 --aoi 16 --sim-latency 0
//
// --sim-latency delays every message by N ms in each direction in-process
// (inbound handling and outbound sends), so RTT grows by 2N — the same
// shape as netem on both ends — without root. SIGINT exits 0.

import { join } from "node:path";
import { type ServerWebSocket } from "bun";
import { Arena } from "./area.ts";
import { snapshotFor } from "../shared/snapshot.ts";
import {
  MSG,
  decodeInput,
  decodeInputBatch,
  encodeBye,
  encodePong,
  encodeWelcome,
  gridFromWindow,
} from "../net/protocol.ts";

export interface ServerOpts {
  port: number;
  seed: number;
  hz: number;
  broadcastHz: number;
  aoi: number;
  simLatency: number;
  /** Optional static web root (the prototype served its canvas client here;
   *  the PocketJS web build is served separately by tools/web.ts). */
  webRoot: string;
}

interface Conn {
  ws: ServerWebSocket<ConnData>;
  playerId: number;
  bytesIn: number;
  bytesOut: number;
  drops: number;
}

interface ConnData {
  conn: Conn | null;
}

export interface ServerHandle {
  url: string;
  port: number;
  /** The address the socket is bound to; always loopback for this demo. */
  hostname: string;
  arena: Arena;
  close: () => void;
}

const BACKPRESSURE_LIMIT = 256 * 1024; // bytes buffered before we drop a snapshot

export function startServer(opts: ServerOpts): ServerHandle {
  const arena = new Arena({ seed: opts.seed, hz: opts.hz });
  const grid = gridFromWindow(arena.world.window);
  const conns = new Map<number, Conn>();
  const frameMod = Math.max(1, Math.round(opts.hz / opts.broadcastHz));

  const stats = {
    ticks: 0,
    bytesIn: 0,
    bytesOut: 0,
    drops: 0,
    snapshots: 0,
  };

  function send(conn: Conn, buf: ArrayBuffer): void {
    if (conn.ws.getBufferedAmount() > BACKPRESSURE_LIMIT) {
      conn.drops++;
      stats.drops++;
      return;
    }
    conn.ws.send(buf);
    conn.bytesOut += buf.byteLength;
    stats.bytesOut += buf.byteLength;
  }

  function emit(conn: Conn, buf: ArrayBuffer): void {
    if (opts.simLatency > 0) setTimeout(() => send(conn, buf), opts.simLatency);
    else send(conn, buf);
  }

  function broadcast(): void {
    arena.indexPlayers();
    for (const p of arena.players.values()) {
      const conn = conns.get(p.id);
      if (!conn) continue;
      stats.snapshots++;
      emit(conn, snapshotFor(arena, p, opts.aoi));
    }
  }

  const tickTimer = setInterval(() => {
    arena.step();
    stats.ticks++;
    if (arena.frame % frameMod === 0) broadcast();
  }, 1000 / opts.hz);

  function onMessage(ws: ServerWebSocket<ConnData>, msg: string | Buffer<ArrayBuffer>): void {
    // A delayed (--sim-latency) message may land after the socket closed.
    if (ws.readyState !== 1) return;
    if (typeof msg === "string") {
      let join: { type?: string; name?: string; color?: number };
      try {
        join = JSON.parse(msg);
      } catch {
        return;
      }
      if (join.type !== "join" || ws.data.conn) return;
      const name = String(join.name ?? "anon").slice(0, 16);
      const color = (Number(join.color) | 0) & 0x0f;
      const p = arena.add(name, color);
      const conn: Conn = { ws, playerId: p.id, bytesIn: 0, bytesOut: 0, drops: 0 };
      ws.data.conn = conn;
      conns.set(p.id, conn);
      emit(conn, encodeWelcome(p.id, arena.seed, arena.x0, arena.y0, grid));
      return;
    }
    const conn = ws.data.conn;
    if (!conn) return;
    conn.bytesIn += msg.byteLength;
    stats.bytesIn += msg.byteLength;
    const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const kind = v.getUint8(0);
    if (kind === MSG.input) {
      const p = arena.players.get(conn.playerId);
      if (p) {
        const inp = decodeInput(msg);
        arena.pushInput(p, inp.seq, inp.buttons);
      }
    } else if (kind === MSG.inputBatch) {
      // v2: one message carrying up to BATCH_SIZE consecutive reference
      // ticks; expand into the same per-tick queue as plain INPUT.
      const p = arena.players.get(conn.playerId);
      const batch = decodeInputBatch(msg);
      if (p && batch) {
        for (let i = 0; i < batch.buttons.length; i++) {
          arena.pushInput(p, batch.firstSeq + i, batch.buttons[i]!);
        }
      }
    } else if (kind === MSG.ping) {
      emit(conn, encodePong(v.getUint32(1, true), v.getUint32(5, true)));
    }
  }

  const server = Bun.serve<ConnData>({
    // Localhost-only by design: the demo never accepts non-loopback
    // connections (hard constraint of the task).
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req: Request, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const ok = srv.upgrade(req, { data: { conn: null } satisfies ConnData });
        if (ok) return undefined as never;
        return new Response("upgrade failed", { status: 400 });
      }
      if (!opts.webRoot) return new Response("not found", { status: 404 });
      // Static web client (optional; the PocketJS web build is served
      // separately by tools/web.ts).
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const resolved = join(opts.webRoot, rel);
      if (!resolved.startsWith(opts.webRoot)) return new Response("forbidden", { status: 403 });
      const file = Bun.file(resolved);
      return file.size > 0 ? new Response(file) : new Response("not found", { status: 404 });
    },
    websocket: {
      open() {
        // Nothing until JOIN.
      },
      message(ws: ServerWebSocket<ConnData>, msg: string | Buffer<ArrayBuffer>) {
        if (opts.simLatency > 0) {
          const copy = typeof msg === "string" ? msg : Buffer.from(msg);
          setTimeout(() => onMessage(ws, copy), opts.simLatency);
        } else onMessage(ws, msg);
      },
      close(ws: ServerWebSocket<ConnData>) {
        const conn = ws.data.conn;
        if (!conn) return;
        const id = conn.playerId;
        arena.remove(id);
        conns.delete(id);
        for (const other of conns.values()) emit(other, encodeBye(id));
      },
    },
  });

  const handle: ServerHandle = {
    url: `ws://localhost:${server.port}/ws`,
    port: server.port ?? opts.port,
    hostname: server.hostname ?? "127.0.0.1",
    arena,
    close() {
      clearInterval(tickTimer);
      server.stop(true);
    },
  };

  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`wander-online server on ${handle.hostname}:${server.port} (seed 0x${(opts.seed >>> 0).toString(16)}, hz ${opts.hz}, aoi ${opts.aoi}, sim-latency ${opts.simLatency}ms)`);
  return handle;
}

// CLI entry.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string, def: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args[i + 1] ?? def) : def;
  };
  startServer({
    port: Number(flag("port", "8080")),
    seed: Number(flag("seed", String(0x5eed_0001))),
    hz: Number(flag("hz", "20")),
    broadcastHz: Number(flag("broadcast-hz", "10")),
    aoi: Number(flag("aoi", "16")),
    simLatency: Number(flag("sim-latency", "0")),
    webRoot: flag("web", ""),
  });
}
