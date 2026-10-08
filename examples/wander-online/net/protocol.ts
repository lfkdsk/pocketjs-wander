// examples/wander-online/net/protocol.ts — binary wire format, little-endian.
//
// This is the single source of wire constants, shared by the Bun area server
// (server/), the PocketJS client (net/client.ts) and the headless bots. The
// prototype in net/proto had no prediction: INPUT carried no sequence number
// and the server applied "latest mask wins" per host frame. Prediction needs
// an input sequence the server can acknowledge, so:
//
//   client -> server
//     JOIN   text JSON {"type":"join","v":3,...credential fields...}
//     INPUT  0x01 seq u32 buttons u16   (7 B; one per predicted reference tick)
//     INPUT_BATCH 0x03 firstSeq u32 count u8 buttons[count] u16
//                    (v2: up to BATCH_SIZE reference ticks packed in one
//                    message, so a 60 Hz client sends at 20 Hz; firstSeq is
//                    the seq of buttons[0], the rest follow consecutively)
//     PING   0x02 id u32 t u32          (9 B; t = client millisecond clock)
//   server -> client
//     WELCOME 0x10 you u32 seed u32 x0 i32 y0 i32 grid[WINDOW*WINDOW] u8
//     WELCOME4 0x11 you u32 seed u32 generator u16 epoch u32,
//                     absolute mover, realmRevision u32 serverTimeMs f64,
//                     realmId utf8
//     STATE   0x20 frame u32 ackSeq u32 n u8
//                    ( n x: id u32 tx u8 ty u8 dx i8 dy i8 dir u8
//                            phase u8 stepDir u8 flags u8 )
//                    [ roomOnline u16 allOnline u16 ]
//             dx/dy: pixel offset from that tile (the kit's absolute move.px
//             minus tx*16), mid-step only; phase is the step phase (0..8),
//             stepDir the direction of the current step; flags: bit0 moving,
//             bit1 walking, bits2..5 color. The full movement state is on
//             the wire so a client correction can replace the whole mover
//             (position alone leaves phase/walking offset and cascades).
//             ackSeq: the last INPUT sequence the server applied for THIS
//             recipient — the reconciliation watermark.
//             The optional 4-byte population tail reports this room and the
//             whole service. It is deliberately after the counted entity
//             rows: old clients ignore it, while new clients fall back to
//             their AOI count when talking to an old server.
//     STATE4  0x21 frame u32 ackSeq u32 epoch u32 n u8
//                    ( n x: id u32 tx i32 ty i32 dx i8 dy i8 dir u8
//                            phase u8 stepDir u8 flags u8 )
//                    [ roomOnline u16 allOnline u16 ]
//             v4 keeps the v3 movement representation but makes tile
//             coordinates signed i32 and validates the complete payload.
//     PONG    0x30 id u32 t u32
//     BYE     0x40 id u32
//     ROSTER  0x50 n u8
//                    ( n x: id u32 nameLen u8 name[nameLen] u8 look u8 )
//             Who is who: id -> chosen name and W-CHAR look id. Sent on join
//             (the full roster to the newcomer, the one new entry to everyone
//             else) and on profile changes; never in the per-frame STATE
//             snapshots. Names are UTF-8, at most 12 code points (server-
//             validated), so an entry is at most 42 B and a 32-player roster
//             fits in one message. Clients reconcile by id.
//
// STATE is a full AOI snapshot every broadcast: idempotent, so a dropped
// packet costs nothing but one frame, and clients reconcile by id set.

import { WINDOW } from "../../wander/window.ts";
import type { WindowBuild } from "../../wander/window.ts";
import { stringToUtf8, utf8ToString } from "../shared/utf8.ts";

export const MSG = {
  input: 0x01,
  ping: 0x02,
  inputBatch: 0x03,
  welcome: 0x10,
  welcome4: 0x11,
  state: 0x20,
  state4: 0x21,
  pong: 0x30,
  bye: 0x40,
  roster: 0x50,
} as const;

/** Infinite-realm wire version. v3 remains the frozen-window legacy wire. */
export const WORLD_PROTOCOL_VERSION = 4;

/** Reference ticks packed into one INPUT_BATCH. The client predicts one
 *  tick per INPUT as before; only the transport packing changes, so the
 *  server still consumes one input per reference tick. 3 ticks at 60 Hz
 *  reference = one 20 Hz message, which keeps a client under the hosted
 *  server's per-connection message rate limit. */
export const BATCH_SIZE = 3;

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
export const ENTITY4_BYTES = 18;
export const STATE_HEADER_BYTES = 10;
export const STATE4_HEADER_BYTES = 14;
export const STATE_POPULATION_BYTES = 4;
export const MAX_AOI = 255;
/** Upper bound on a STATE payload: header + capped entities + population. */
export const MAX_STATE_BYTES = STATE_HEADER_BYTES + MAX_AOI * ENTITY_BYTES + STATE_POPULATION_BYTES;
export const MAX_STATE4_BYTES = STATE4_HEADER_BYTES + MAX_AOI * ENTITY4_BYTES + STATE_POPULATION_BYTES;

const WELCOME4_FIXED_BYTES = 42;

export interface Welcome4 {
  you: number;
  seed: number;
  generatorVersion: number;
  epoch: number;
  realmId: string;
  realmRevision: number;
  serverTimeMs: number;
  mover: Omit<WireEntity, "id" | "color">;
}

export function encodeInput(seq: number, buttons: number): ArrayBuffer {
  const b = new ArrayBuffer(7);
  const v = new DataView(b);
  v.setUint8(0, MSG.input);
  v.setUint32(1, seq >>> 0, true);
  v.setUint16(5, buttons, true);
  return b;
}

/** Pack up to BATCH_SIZE consecutive reference ticks into one message.
 *  `firstSeq` is the sequence number of buttons[0]; the rest follow
 *  consecutively (the server expands them into firstSeq..firstSeq+count-1). */
export function encodeInputBatch(firstSeq: number, buttons: number[]): ArrayBuffer {
  const count = Math.min(buttons.length, BATCH_SIZE);
  const b = new ArrayBuffer(6 + count * 2);
  const v = new DataView(b);
  v.setUint8(0, MSG.inputBatch);
  v.setUint32(1, firstSeq >>> 0, true);
  v.setUint8(5, count);
  for (let i = 0; i < count; i++) v.setUint16(6 + i * 2, buttons[i]!, true);
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

/** v4 admission payload. The realm id is length-prefixed UTF-8 and the
 * complete authoritative mover is present even though A-phase spawns are
 * currently at rest; this keeps restart/rebase semantics explicit. */
export function encodeWelcome4(welcome: Welcome4): ArrayBuffer {
  const realm = stringToUtf8(welcome.realmId);
  if (realm.byteLength > 0xff) throw new Error("WELCOME4 realm id exceeds 255 UTF-8 bytes");
  const b = new ArrayBuffer(WELCOME4_FIXED_BYTES + realm.byteLength);
  const v = new DataView(b);
  const m = welcome.mover;
  v.setUint8(0, MSG.welcome4);
  v.setUint32(1, welcome.you >>> 0, true);
  v.setUint32(5, welcome.seed >>> 0, true);
  v.setUint16(9, welcome.generatorVersion & 0xffff, true);
  v.setUint32(11, welcome.epoch >>> 0, true);
  v.setInt32(15, m.tx, true);
  v.setInt32(19, m.ty, true);
  v.setInt8(23, m.px);
  v.setInt8(24, m.py);
  v.setUint8(25, m.dir & 0x03);
  v.setUint8(26, m.phase & 0x0f);
  v.setUint8(27, m.stepDir & 0x03);
  v.setUint8(28, (m.moving ? 1 : 0) | (m.walking ? 2 : 0));
  v.setUint32(29, welcome.realmRevision >>> 0, true);
  v.setFloat64(33, welcome.serverTimeMs, true);
  v.setUint8(41, realm.byteLength);
  new Uint8Array(b, WELCOME4_FIXED_BYTES).set(realm);
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

export interface StatePopulation {
  /** Number of players admitted to this room (not merely in the AOI). */
  roomOnline: number;
  /** Number of players admitted across every room in the service. */
  allOnline: number;
}

export function encodeState(
  frame: number,
  ackSeq: number,
  entities: WireEntity[],
  population?: StatePopulation,
): ArrayBuffer {
  const n = Math.min(entities.length, MAX_AOI);
  const entityEnd = STATE_HEADER_BYTES + n * ENTITY_BYTES;
  const b = new ArrayBuffer(entityEnd + (population ? STATE_POPULATION_BYTES : 0));
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
  if (population) {
    const roomOnline = Math.max(0, Math.min(0xffff, population.roomOnline)) | 0;
    const allOnline = Math.max(roomOnline, Math.min(0xffff, population.allOnline)) | 0;
    v.setUint16(entityEnd, roomOnline, true);
    v.setUint16(entityEnd + 2, allOnline, true);
  }
  return b;
}

/** Signed-world v4 snapshot. Unlike the legacy decoder contract, the v4
 * counterpart below accepts only the two exact legal lengths. */
export function encodeState4(
  frame: number,
  ackSeq: number,
  epoch: number,
  entities: WireEntity[],
  population?: StatePopulation,
): ArrayBuffer {
  const n = Math.min(entities.length, MAX_AOI);
  const entityEnd = STATE4_HEADER_BYTES + n * ENTITY4_BYTES;
  const b = new ArrayBuffer(entityEnd + (population ? STATE_POPULATION_BYTES : 0));
  const v = new DataView(b);
  v.setUint8(0, MSG.state4);
  v.setUint32(1, frame >>> 0, true);
  v.setUint32(5, ackSeq >>> 0, true);
  v.setUint32(9, epoch >>> 0, true);
  v.setUint8(13, n);
  let o = STATE4_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const e = entities[i]!;
    v.setUint32(o, e.id >>> 0, true);
    v.setInt32(o + 4, e.tx, true);
    v.setInt32(o + 8, e.ty, true);
    v.setInt8(o + 12, e.px);
    v.setInt8(o + 13, e.py);
    v.setUint8(o + 14, e.dir & 0x03);
    v.setUint8(o + 15, e.phase & 0x0f);
    v.setUint8(o + 16, e.stepDir & 0x03);
    v.setUint8(o + 17, (e.moving ? 1 : 0) | (e.walking ? 2 : 0) | ((e.color & 0x0f) << 2));
    o += ENTITY4_BYTES;
  }
  if (population) {
    const roomOnline = Math.max(0, Math.min(0xffff, population.roomOnline)) | 0;
    const allOnline = Math.max(roomOnline, Math.min(0xffff, population.allOnline)) | 0;
    v.setUint16(entityEnd, roomOnline, true);
    v.setUint16(entityEnd + 2, allOnline, true);
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

/** One ROSTER row: a player's chosen name and W-CHAR look id. */
export interface RosterEntry {
  id: number;
  name: string;
  look: number;
}

export const ROSTER_MAX = 255;

/** Encode a ROSTER message (id -> name, look). Names are UTF-8 and capped at
 *  12 code points by the server, so an entry never exceeds 42 B. */
export function encodeRoster(entries: readonly RosterEntry[]): ArrayBuffer {
  const n = Math.min(entries.length, ROSTER_MAX);
  const parts: ArrayBuffer[] = [];
  let total = 2; // kind + count
  for (let i = 0; i < n; i++) {
    const e = entries[i]!;
    const nameBytes = stringToUtf8(e.name);
    const len = 4 + 1 + nameBytes.byteLength + 1;
    const b = new ArrayBuffer(len);
    const v = new DataView(b);
    v.setUint32(0, e.id >>> 0, true);
    v.setUint8(4, nameBytes.byteLength);
    new Uint8Array(b, 5).set(nameBytes);
    v.setUint8(5 + nameBytes.byteLength, e.look & 0xff);
    parts.push(b);
    total += len;
  }
  const out = new ArrayBuffer(total);
  const ov = new DataView(out);
  ov.setUint8(0, MSG.roster);
  ov.setUint8(1, n);
  let o = 2;
  for (const p of parts) {
    new Uint8Array(out, o).set(new Uint8Array(p));
    o += p.byteLength;
  }
  return out;
}

/** Decode a ROSTER message. Returns null when the payload is truncated or
 *  carries an over-capacity count, so a corrupt/garbage message is dropped
 *  rather than crashing the client. */
export function decodeRoster(buf: ArrayBuffer | Uint8Array): RosterEntry[] | null {
  const v = buf instanceof Uint8Array ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength) : new DataView(buf);
  if (buf.byteLength < 2) return null;
  const n = v.getUint8(1);
  if (n > ROSTER_MAX) return null;
  const entries: RosterEntry[] = [];
  let o = 2;
  for (let i = 0; i < n; i++) {
    if (o + 5 > buf.byteLength) return null;
    const id = v.getUint32(o, true);
    const nameLen = v.getUint8(o + 4);
    o += 5;
    if (o + nameLen + 1 > buf.byteLength) return null;
    let name: string;
    if (buf instanceof Uint8Array) {
      name = utf8ToString(buf.subarray(o, o + nameLen));
    } else {
      name = utf8ToString(new Uint8Array(buf, o, nameLen));
    }
    o += nameLen;
    const look = v.getUint8(o);
    o += 1;
    entries.push({ id, name, look });
  }
  return entries;
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

/** One decoded INPUT_BATCH (server direction). Returns null when the
 *  payload is truncated or carries an empty/over-capacity batch. */
export interface DecodedInputBatch {
  firstSeq: number;
  buttons: number[];
}

export function decodeInputBatch(buf: ArrayBuffer | Uint8Array): DecodedInputBatch | null {
  const v = buf instanceof Uint8Array ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength) : new DataView(buf);
  if (buf.byteLength < 7) return null;
  const count = v.getUint8(5);
  if (count === 0 || count > BATCH_SIZE || buf.byteLength < 6 + count * 2) return null;
  const buttons: number[] = [];
  for (let i = 0; i < count; i++) buttons.push(v.getUint16(6 + i * 2, true));
  return { firstSeq: v.getUint32(1, true), buttons };
}

/** One row of a decoded STATE snapshot (server -> client direction).
 *  Accepts an ArrayBuffer or a Uint8Array view (the socket SDK's binary
 *  message) so the client need not copy. */
export interface DecodedState {
  frame: number;
  ackSeq: number;
  entities: WireEntity[];
  /** Null for a legacy STATE with no optional population tail. */
  roomOnline: number | null;
  /** Null for a legacy STATE with no optional population tail. */
  allOnline: number | null;
}

export interface DecodedState4 extends DecodedState {
  /** Connection/world epoch. A mismatch invalidates prediction history. */
  epoch: number;
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
  const hasPopulation = buf.byteLength >= o + STATE_POPULATION_BYTES;
  return {
    frame: v.getUint32(1, true),
    ackSeq: v.getUint32(5, true),
    entities,
    roomOnline: hasPopulation ? v.getUint16(o, true) : null,
    allOnline: hasPopulation ? v.getUint16(o + 2, true) : null,
  };
}

/** Decode one v4 snapshot, rejecting truncation, trailing garbage and a
 * wrong message kind before reading any entity field. */
export function decodeState4(buf: ArrayBuffer | Uint8Array): DecodedState4 | null {
  if (buf.byteLength < STATE4_HEADER_BYTES) return null;
  const v = viewOf(buf);
  if (v.getUint8(0) !== MSG.state4) return null;
  const n = v.getUint8(13);
  const entityEnd = STATE4_HEADER_BYTES + n * ENTITY4_BYTES;
  if (buf.byteLength !== entityEnd && buf.byteLength !== entityEnd + STATE_POPULATION_BYTES) return null;
  const entities: WireEntity[] = [];
  let o = STATE4_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const flags = v.getUint8(o + 17);
    entities.push({
      id: v.getUint32(o, true),
      tx: v.getInt32(o + 4, true),
      ty: v.getInt32(o + 8, true),
      px: v.getInt8(o + 12),
      py: v.getInt8(o + 13),
      dir: v.getUint8(o + 14),
      phase: v.getUint8(o + 15),
      stepDir: v.getUint8(o + 16),
      moving: (flags & 1) === 1,
      walking: (flags & 2) === 2,
      color: (flags >> 2) & 0x0f,
    });
    o += ENTITY4_BYTES;
  }
  const hasPopulation = buf.byteLength === entityEnd + STATE_POPULATION_BYTES;
  return {
    frame: v.getUint32(1, true),
    ackSeq: v.getUint32(5, true),
    epoch: v.getUint32(9, true),
    entities,
    roomOnline: hasPopulation ? v.getUint16(o, true) : null,
    allOnline: hasPopulation ? v.getUint16(o + 2, true) : null,
  };
}

/** Decode the v4 realm greeting. Returns null on malformed UTF-8 framing or
 * any non-exact payload length so a corrupt packet cannot become a partial
 * world epoch. */
export function decodeWelcome4(buf: ArrayBuffer | Uint8Array): Welcome4 | null {
  if (buf.byteLength < WELCOME4_FIXED_BYTES) return null;
  const v = viewOf(buf);
  if (v.getUint8(0) !== MSG.welcome4) return null;
  const realmLen = v.getUint8(41);
  if (buf.byteLength !== WELCOME4_FIXED_BYTES + realmLen) return null;
  const bytes = buf instanceof Uint8Array
    ? buf.subarray(WELCOME4_FIXED_BYTES, WELCOME4_FIXED_BYTES + realmLen)
    : new Uint8Array(buf, WELCOME4_FIXED_BYTES, realmLen);
  const flags = v.getUint8(28);
  return {
    you: v.getUint32(1, true),
    seed: v.getUint32(5, true),
    generatorVersion: v.getUint16(9, true),
    epoch: v.getUint32(11, true),
    mover: {
      tx: v.getInt32(15, true),
      ty: v.getInt32(19, true),
      px: v.getInt8(23),
      py: v.getInt8(24),
      dir: v.getUint8(25),
      phase: v.getUint8(26),
      stepDir: v.getUint8(27),
      moving: (flags & 1) === 1,
      walking: (flags & 2) === 2,
    },
    realmRevision: v.getUint32(29, true),
    serverTimeMs: v.getFloat64(33, true),
    realmId: utf8ToString(bytes),
  };
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
