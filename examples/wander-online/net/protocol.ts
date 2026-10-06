// examples/wander-online/net/protocol.ts — binary wire format, little-endian.
//
// This is the single source of wire constants, shared by the Bun area server
// (server/), the PocketJS client (net/client.ts) and the headless bots. The
// prototype in net/proto had no prediction: INPUT carried no sequence number
// and the server applied "latest mask wins" per host frame. Prediction needs
// an input sequence the server can acknowledge, so:
//
//   client -> server
//     JOIN   text JSON {"type":"join","name":string,"color":uint8}
//     INPUT  0x01 seq u32 buttons u16   (7 B; one per predicted reference tick)
//     PING   0x02 id u32 t u32          (9 B; t = client millisecond clock)
//   server -> client
//     WELCOME 0x10 you u32 seed u32 x0 i32 y0 i32 grid[WINDOW*WINDOW] u8
//     STATE   0x20 frame u32 ackSeq u32 n u8
//                    ( n x: id u32 tx u8 ty u8 dx i8 dy i8 dir u8
//                            phase u8 stepDir u8 flags u8 )
//             dx/dy: pixel offset from that tile (the kit's absolute move.px
//             minus tx*16), mid-step only; phase is the step phase (0..8),
//             stepDir the direction of the current step; flags: bit0 moving,
//             bit1 walking, bits2..5 color. The full movement state is on
//             the wire so a client correction can replace the whole mover
//             (position alone leaves phase/walking offset and cascades).
//             ackSeq: the last INPUT sequence the server applied for THIS
//             recipient — the reconciliation watermark.
//     PONG    0x30 id u32 t u32
//     BYE     0x40 id u32
//
// STATE is a full AOI snapshot every broadcast: idempotent, so a dropped
// packet costs nothing but one frame, and clients reconcile by id set.

import { WINDOW } from "../../wander/window.ts";
import type { WindowBuild } from "../../wander/window.ts";

export const MSG = {
  input: 0x01,
  ping: 0x02,
  welcome: 0x10,
  state: 0x20,
  pong: 0x30,
  bye: 0x40,
} as const;

/** D-pad bits, same values the kit's engine uses. */
export const BTN = { up: 0x0010, right: 0x0020, down: 0x0040, left: 0x0080 } as const;

/** Tile classes for the client's palette. */
export const TILE = {
  void: 0,
  block: 1,
  road: 2,
  grass: 3,
  mud: 4,
  sand: 5,
  snow: 6,
  plaza: 7,
} as const;

export const ENTITY_BYTES = 12;
export const STATE_HEADER_BYTES = 10;
export const MAX_AOI = 255;
/** Upper bound on a STATE payload: header + cap entities. */
export const MAX_STATE_BYTES = STATE_HEADER_BYTES + MAX_AOI * ENTITY_BYTES;

export function encodeInput(seq: number, buttons: number): ArrayBuffer {
  const b = new ArrayBuffer(7);
  const v = new DataView(b);
  v.setUint8(0, MSG.input);
  v.setUint32(1, seq >>> 0, true);
  v.setUint16(5, buttons, true);
  return b;
}

export function encodePing(id: number, t: number): ArrayBuffer {
  const b = new ArrayBuffer(9);
  const v = new DataView(b);
  v.setUint8(0, MSG.ping);
  v.setUint32(1, id >>> 0, true);
  v.setUint32(5, t >>> 0, true);
  return b;
}

export function encodeWelcome(you: number, seed: number, x0: number, y0: number, grid: Uint8Array): ArrayBuffer {
  const b = new ArrayBuffer(1 + 4 + 4 + 4 + 4 + grid.length);
  const v = new DataView(b);
  v.setUint8(0, MSG.welcome);
  v.setUint32(1, you >>> 0, true);
  v.setUint32(5, seed >>> 0, true);
  v.setInt32(9, x0, true);
  v.setInt32(13, y0, true);
  new Uint8Array(b, 17).set(grid);
  return b;
}

export interface WireEntity {
  id: number;
  tx: number;
  ty: number;
  /** Pixel offset from tile (tx, ty), -15..15 while stepping. */
  px: number;
  py: number;
  /** Facing direction (0..3). */
  dir: number;
  /** Step phase (0..8). */
  phase: number;
  /** Direction of the current step (0..3). */
  stepDir: number;
  moving: boolean;
  walking: boolean;
  color: number;
}

export function encodeState(frame: number, ackSeq: number, entities: WireEntity[]): ArrayBuffer {
  const n = Math.min(entities.length, MAX_AOI);
  const b = new ArrayBuffer(STATE_HEADER_BYTES + n * ENTITY_BYTES);
  const v = new DataView(b);
  v.setUint8(0, MSG.state);
  v.setUint32(1, frame >>> 0, true);
  v.setUint32(5, ackSeq >>> 0, true);
  v.setUint8(9, n);
  let o = STATE_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const e = entities[i]!;
    v.setUint32(o, e.id >>> 0, true);
    v.setUint8(o + 4, e.tx & 0xff);
    v.setUint8(o + 5, e.ty & 0xff);
    v.setInt8(o + 6, e.px);
    v.setInt8(o + 7, e.py);
    v.setUint8(o + 8, e.dir & 0x07);
    v.setUint8(o + 9, e.phase & 0x0f);
    v.setUint8(o + 10, e.stepDir & 0x07);
    v.setUint8(o + 11, (e.moving ? 1 : 0) | (e.walking ? 2 : 0) | ((e.color & 0x0f) << 2));
    o += ENTITY_BYTES;
  }
  return b;
}

export function encodePong(id: number, t: number): ArrayBuffer {
  const b = new ArrayBuffer(9);
  const v = new DataView(b);
  v.setUint8(0, MSG.pong);
  v.setUint32(1, id >>> 0, true);
  v.setUint32(5, t >>> 0, true);
  return b;
}

export function encodeBye(id: number): ArrayBuffer {
  const b = new ArrayBuffer(5);
  new DataView(b).setUint8(0, MSG.bye);
  new DataView(b).setUint32(1, id >>> 0, true);
  return b;
}

/** One decoded INPUT (server direction). Accepts an ArrayBuffer or a
 *  Uint8Array view (Bun's Buffer) so the server need not copy. */
export interface DecodedInput {
  seq: number;
  buttons: number;
}

export function decodeInput(buf: ArrayBuffer | Uint8Array): DecodedInput {
  const v = buf instanceof Uint8Array ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength) : new DataView(buf);
  return { seq: v.getUint32(1, true), buttons: v.getUint16(5, true) };
}

/** One row of a decoded STATE snapshot (server -> client direction).
 *  Accepts an ArrayBuffer or a Uint8Array view (the socket SDK's binary
 *  message) so the client need not copy. */
export interface DecodedState {
  frame: number;
  ackSeq: number;
  entities: WireEntity[];
}

function viewOf(buf: ArrayBuffer | Uint8Array): DataView {
  return buf instanceof Uint8Array ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength) : new DataView(buf);
}

export function decodeState(buf: ArrayBuffer | Uint8Array): DecodedState {
  const v = viewOf(buf);
  const n = v.getUint8(9);
  const entities: WireEntity[] = [];
  let o = STATE_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const flags = v.getUint8(o + 11);
    entities.push({
      id: v.getUint32(o, true),
      tx: v.getUint8(o + 4),
      ty: v.getUint8(o + 5),
      px: v.getInt8(o + 6),
      py: v.getInt8(o + 7),
      dir: v.getUint8(o + 8),
      phase: v.getUint8(o + 9),
      stepDir: v.getUint8(o + 10),
      moving: (flags & 1) === 1,
      walking: (flags & 2) === 2,
      color: (flags >> 2) & 0x0f,
    });
    o += ENTITY_BYTES;
  }
  return { frame: v.getUint32(1, true), ackSeq: v.getUint32(5, true), entities };
}

export function decodeWelcome(buf: ArrayBuffer | Uint8Array): { you: number; seed: number; x0: number; y0: number; grid: Uint8Array } {
  const v = viewOf(buf);
  const byteOffset = buf instanceof Uint8Array ? buf.byteOffset : 0;
  const grid = buf instanceof Uint8Array
    ? new Uint8Array(buf.buffer, byteOffset + 17, WINDOW * WINDOW)
    : new Uint8Array(buf, 17, WINDOW * WINDOW);
  return {
    you: v.getUint32(1, true),
    seed: v.getUint32(5, true),
    x0: v.getInt32(9, true),
    y0: v.getInt32(13, true),
    grid,
  };
}

/**
 * Classify the frozen window's cells for the client's palette: passage
 * blocks, roads, biome bases, developed ground. One u8 per cell, row-major.
 * The server sends this once, in WELCOME.
 */
export function gridFromWindow(w: WindowBuild): Uint8Array {
  const map = w.project.maps[0]!;
  const blocked = new Set<number>();
  for (const [at] of map.passage ?? []) blocked.add(at);
  const grid = new Uint8Array(WINDOW * WINDOW);
  for (let i = 0; i < grid.length; i++) {
    if (blocked.has(i)) {
      grid[i] = TILE.block;
      continue;
    }
    if (w.roads[i]) {
      grid[i] = TILE.road;
      continue;
    }
    const id = map.ground[i]!;
    const n = id.startsWith("ninja.") ? Number(id.slice(6)) : NaN;
    if (n === 90) grid[i] = TILE.grass;
    else if (n === 91) grid[i] = TILE.mud;
    else if (n === 92) grid[i] = TILE.sand;
    else if (n === 93) grid[i] = TILE.snow;
    else grid[i] = TILE.plaza;
  }
  return grid;
}
