// examples/wander-online/OnlineView.tsx — the wander-online world on screen.
//
// The net client (net/client.ts) owns the socket, the prediction and the
// interpolation; this view only presents it:
//
//   world    the frozen window's classified grid (WELCOME), drawn as a
//            pooled grid of 16x16 bgColor views that follow the camera
//   people   the local player at its predicted position (screen centre),
//            and every remote player at its interpolated position (100 ms
//            behind real time)
//   HUD      connection status, online count, RTT, correction count
//   input    the held d-pad is predicted locally and sent to the server;
//            an auto-walk driver walks when no key is held, so demo windows
//            see each other move. Any d-pad key takes over; auto resumes
//            after 10 idle seconds.
//
// Test hooks: globalThis.__onlineState (a mutable HUD+position record the
// desktop host's log can read) and globalThis.__onlinePerf (per-frame phase
// times when __onlinePerfOn is set).

import { batch, createSignal } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createElement, insertNode, setProp } from "@pocketjs/framework/renderer";
import { jump } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { simulationHz } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { WINDOW } from "../wander/window.ts";
import { TILE } from "./net/protocol.ts";
import { OnlineClient } from "./net/client.ts";

const TILE_PX = 16;
const PALETTE = ["#3d4450", "#6e7681", "#c9a86a", "#3f7d33", "#7a5c3e", "#d8c487", "#e8eef2", "#9aa7b4"];
const PLAYER_COLORS = ["#ff6b6b", "#4dabf7", "#51cf66", "#ffd43b", "#cc5de8", "#22b8cf", "#ff922b", "#94d82d", "#f783ac", "#845ef7", "#20c997", "#ffa94d", "#74c0fc", "#b2f2bb", "#e599f7", "#dee2e6"];
const IDLE_RESUME_SECONDS = 10;
const HUD_EVERY = 6;

declare global {
  // eslint-disable-next-line no-var
  var __onlineState: OnlinePublished | undefined;
  // eslint-disable-next-line no-var
  var __onlinePerfOn: boolean | undefined;
  // eslint-disable-next-line no-var
  var __onlinePerf: Record<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __onlineUrl: string | undefined;
  // eslint-disable-next-line no-var
  var __onlineName: string | undefined;
  // eslint-disable-next-line no-var
  var __onlineColor: number | undefined;
}

export interface OnlinePublished {
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
  /** Remote players currently interpolated: id and pixel position. The
   *  acceptance demo reads this over CDP to prove the web client sees the
   *  other two clients walk (state, not screenshots). */
  remote: { id: number; x: number; y: number }[];
}

const DEFAULT_URL = "ws://127.0.0.1:8080/ws";

/** A bounded auto-walk driver: hold a direction for 1-3 s, sometimes stop.
 *  Stays within RADIUS tiles of `home` so demo clients remain in each
 *  other's viewport. Not deterministic (it reads the clock) — that is fine,
 *  its output is ordinary predicted input. */
class AutoWalk {
  private held = 0;
  private nextChange = 0;
  private now: () => number;
  home: { x: number; y: number };
  private readonly radius: number;
  constructor(now: () => number, home: { x: number; y: number }, radius = 8) {
    this.now = now;
    this.home = home;
    this.radius = radius;
  }
  mask(tx: number, ty: number): number {
    const t = this.now();
    if (t >= this.nextChange) {
      const dx = this.home.x - tx;
      const dy = this.home.y - ty;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      if (dist > this.radius) {
        // Walk back toward home.
        this.held = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? BTN.RIGHT : BTN.LEFT) : (dy > 0 ? BTN.DOWN : BTN.UP);
      } else {
        const dirs = [BTN.UP, BTN.RIGHT, BTN.DOWN, BTN.LEFT];
        this.held = Math.random() < 0.2 ? 0 : dirs[Math.floor(Math.random() * 4)]!;
      }
      this.nextChange = t + 800 + Math.random() * 1500;
    }
    return this.held;
  }
  reset(): void {
    this.nextChange = 0;
  }
}

export function OnlineView() {
  const hz = simulationHz();
  const g = globalThis as { __onlineUrl?: string; __onlineName?: string; __onlineColor?: number; __onlinePerfOn?: boolean };
  const url = g.__onlineUrl ?? DEFAULT_URL;
  const name = g.__onlineName ?? `guest${Math.floor(Math.random() * 1000)}`;
  const color = (g.__onlineColor ?? Math.floor(Math.random() * 16)) & 0x0f;
  const client = new OnlineClient(url, name, color);
  const auto = new AutoWalk(
    () => (globalThis.performance ? globalThis.performance.now() : Date.now()),
    { x: WINDOW / 2, y: WINDOW / 2 },
  );
  let autoHome = false;
  const perfOn = g.__onlinePerfOn === true;

  const vp = { w: 480, h: 272 };
  const cols = Math.ceil(vp.w / TILE_PX) + 2;
  const rows = Math.ceil(vp.h / TILE_PX) + 2;

  // -- world grid ----------------------------------------------------------
  const gridRoot = createElement("view");
  setProp(gridRoot, "style", { posType: 1, insetL: 0, insetT: 0, width: cols * TILE_PX, height: rows * TILE_PX });
  setProp(gridRoot, "debugName", "online-grid");
  const cells: NodeMirror[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const node = createElement("view");
    setProp(node, "style", { posType: 1, insetL: i * TILE_PX, insetT: j * TILE_PX, width: TILE_PX, height: TILE_PX, bgColor: PALETTE[0] });
    insertNode(gridRoot, node);
    cells.push(node);
  }
  let camTileX = -1;
  let camTileY = -1;

  // -- people ---------------------------------------------------------------
  const peopleRoot = createElement("view");
  setProp(peopleRoot, "style", { posType: 1, insetL: 0, insetT: 0, width: vp.w, height: vp.h });
  setProp(peopleRoot, "debugName", "online-people");
  const local = createElement("view");
  setProp(local, "style", { posType: 1, insetL: 0, insetT: 0, width: 10, height: 10, bgColor: PLAYER_COLORS[color], borderWidth: 1, borderColor: "#ffffff" });
  insertNode(peopleRoot, local);
  jump(local, "translateX", Math.round(vp.w / 2 - 5));
  jump(local, "translateY", Math.round(vp.h / 2 - 5));
  const remotePool: NodeMirror[] = [];
  const remoteUsed = new Map<number, NodeMirror>();
  const remoteHidden = new Set<number>();

  // -- HUD -------------------------------------------------------------------
  const [statusText, setStatusText] = createSignal("connecting");
  const [countText, setCountText] = createSignal("");
  const [posText, setPosText] = createSignal("");
  let hudTimer = 0;
  let logTimer = 0;
  let idle = 0;
  let autoMode = true;
  let prevButtons = 0;

  const camera = () => {
    const p = client.predictor?.current;
    if (!p) return { x: WINDOW * 8, y: WINDOW * 8, tx: 0, ty: 0 };
    const m = p.move;
    return { x: m.px, y: m.py, tx: m.tx, ty: m.ty };
  };

  const syncGrid = () => {
    const grid = client.grid;
    if (!grid) return;
    const cam = camera();
    const ctx = Math.floor(cam.x / TILE_PX);
    const cty = Math.floor(cam.y / TILE_PX);
    if (ctx === camTileX && cty === camTileY) return;
    camTileX = ctx;
    camTileY = cty;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const wx = ctx + i;
      const wy = cty + j;
      const t = wx >= 0 && wy >= 0 && wx < WINDOW && wy < WINDOW ? grid[wy * WINDOW + wx]! : TILE.void;
      setProp(cells[j * cols + i]!, "style", { bgColor: PALETTE[t] });
    }
  };

  const syncPeople = (now: number) => {
    const cam = camera();
    const subX = cam.x - Math.floor(cam.x / TILE_PX) * TILE_PX;
    const subY = cam.y - Math.floor(cam.y / TILE_PX) * TILE_PX;
    jump(gridRoot, "translateX", -Math.round(subX));
    jump(gridRoot, "translateY", -Math.round(subY));
    // Remote players at interpolated positions relative to the camera.
    const ids = client.interp.ids();
    remoteHidden.clear();
    for (const id of remoteUsed.keys()) remoteHidden.add(id);
    for (const id of ids) {
      const pos = client.interp.renderAt(id, now);
      if (!pos) continue;
      remoteHidden.delete(id);
      let node = remoteUsed.get(id);
      if (!node) {
        node = remotePool.pop();
        if (!node) {
          node = createElement("view");
          setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: 10, height: 10 });
          insertNode(peopleRoot, node);
        }
        setProp(node, "style", { bgColor: PLAYER_COLORS[pos.color] ?? PLAYER_COLORS[0] });
        remoteUsed.set(id, node);
      }
      jump(node, "translateX", Math.round(pos.x - cam.x + vp.w / 2 - 5));
      jump(node, "translateY", Math.round(pos.y - cam.y + vp.h / 2 - 5));
    }
    for (const id of remoteHidden) {
      const rec = remoteUsed.get(id)!;
      remoteUsed.delete(id);
      remotePool.push(rec);
      jump(rec, "translateX", -100);
    }
  };

  const publish = (now: number) => {
    const h = client.hud();
    const cam = camera();
    const out: OnlinePublished = globalThis.__onlineState ?? ({} as OnlinePublished);
    out.status = h.status;
    out.myId = h.myId;
    out.online = h.online;
    out.rtt = h.rtt;
    out.corrections = h.corrections;
    out.unacked = h.unacked;
    out.x = cam.tx;
    out.y = cam.ty;
    out.moving = client.predictor?.current.move.moving ?? false;
    out.auto = autoMode;
    const remote: OnlinePublished["remote"] = [];
    for (const id of client.interp.ids()) {
      const pos = client.interp.renderAt(id, now);
      if (pos) remote.push({ id, x: Math.round(pos.x), y: Math.round(pos.y) });
    }
    out.remote = remote;
    globalThis.__onlineState = out;
  };

  const refreshHud = () => {
    const h = client.hud();
    const cam = camera();
    batch(() => {
      setStatusText(`${h.status.toUpperCase()}  #${h.myId}  RTT ${h.rtt}ms  CORR ${h.corrections}`);
      setCountText(`ONLINE ${h.online}  UNACKED ${h.unacked}`);
      setPosText(`X ${cam.tx}  Y ${cam.ty}  ${autoMode ? "AUTO" : "YOU"}`);
    });
  };

  onFrame((buttons) => {
    const t0 = perfOn && globalThis.performance ? globalThis.performance.now() : 0;
    prevButtons = buttons;
    const dpad = buttons & (BTN.UP | BTN.RIGHT | BTN.DOWN | BTN.LEFT);
    if (dpad) {
      if (autoMode) auto.reset();
      autoMode = false;
      idle = 0;
    } else if (!autoMode && ++idle >= IDLE_RESUME_SECONDS * hz) {
      autoMode = true;
    }
    const autoMask = autoMode ? auto.mask(client.predictor?.current.move.tx ?? 0, client.predictor?.current.move.ty ?? 0) : 0;
    if (!autoHome && client.predictor) {
      autoHome = true;
      auto.home = { x: client.predictor.current.move.tx, y: client.predictor.current.move.ty };
    }
    client.onFrame(buttons, hz, autoMask);
    const t1 = perfOn && globalThis.performance ? globalThis.performance.now() : 0;
    syncGrid();
    syncPeople(globalThis.performance ? globalThis.performance.now() : Date.now());
    const t2 = perfOn && globalThis.performance ? globalThis.performance.now() : 0;
    if (++hudTimer >= HUD_EVERY) {
      hudTimer = 0;
      refreshHud();
    }
    publish(globalThis.performance ? globalThis.performance.now() : Date.now());
    // One JSON state line per second: the headless desktop host's log is
    // how the acceptance demo reads the client's state.
    if (++logTimer >= hz) {
      logTimer = 0;
      console.log(`ONLINE ${JSON.stringify(globalThis.__onlineState)}`);
    }
    if (perfOn && globalThis.performance) {
      globalThis.__onlinePerf = { net: t1 - t0, view: t2 - t1, total: t2 - t0 };
    }
  });
  refreshHud();

  return <View class="w-full h-full overflow-hidden bg-black">
    <View class="absolute overflow-hidden" style={{ posType: 1, insetL: 0, insetT: 0, width: vp.w, height: vp.h }} debugName="online-field">
      {gridRoot as unknown as ReturnType<typeof View>}
      {peopleRoot as unknown as ReturnType<typeof View>}
    </View>
    <View class="absolute" style={{ posType: 1, insetT: 4, insetL: 6, width: 250, height: 30, bgColor: "#0b1626", opacity: 0.84 }} debugName="online-plate" />
    <Text class="text-xs" style={{ posType: 1, insetT: 6, insetL: 12, textColor: "#ffe97a", lineHeight: 12, height: 12 }}>{statusText()}</Text>
    <Text class="text-xs" style={{ posType: 1, insetT: 19, insetL: 12, textColor: "#9fd0ff", lineHeight: 12, height: 12 }}>{countText()}</Text>
    <Text class="text-xs" style={{ posType: 1, insetB: 6, insetL: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{posText()}</Text>
  </View>;
}
