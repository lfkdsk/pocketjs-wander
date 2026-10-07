// examples/wander/WanderView.tsx — the endless world on screen.
//
// The simulation (wander-sim.ts) owns the world, residency, growth and the
// walkable session; this view only presents it:
//
//   world    RenderRing (wander-render.ts): pooled, capped native nodes for
//            the viewport plus a small overscan — fill blocks, seams and
//            roads, the people, and the upper layer (whole-stamp trees and
//            houses) on top
//   people   the player (the kit's walker frames) and the session's
//            residents, positioned from the session state and the window
//            origin; bodies draw between ground and upper, like GameView
//   HUD      seed, world coordinates, mode, the ring minimap (chunks by
//            state around the focus, with the load and unload rings drawn
//            as outlines) and the residency counters
//   input    any d-pad/face button takes the walk over (the sim resumes the
//            auto-wander after 10 idle seconds); SQUARE grows a new seed;
//            TRIANGLE toggles fast travel; SELECT hands back to the driver;
//            a tap (touches(), or a left click on the desktop host's mouse
//            service lines) on the field walks there, on the seed plate
//            grows a new seed. Every live input is sampled once per host
//            frame and enqueued on the sim's scheduled tape at the frame's
//            first reference tick (WanderSim.enqueue), so the live path and
//            replays are the same code path; the recorded tape
//            (globalThis.__wanderTape) replays the session tick-for-tick at
//            any host rate. A slow host still observes a click later than a
//            fast one — inputs are sampled at host frames, the engine's
//            documented contract

import { batch, createSignal, Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createElement, insertNode, setProp } from "@pocketjs/framework/renderer";
import { jump } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { simulationHz } from "@pocketjs/framework/clock";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { touches, BTN } from "@pocketjs/framework/input";
import { deepClone } from "../../vendor/pocket-rpgkit/src/engine/clone.ts";
import { modalChanged, type Modal } from "../../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { walkPose } from "../../vendor/pocket-rpgkit/src/engine/movement.ts";
import { playerImageKey, type PlayerFrames } from "../../vendor/pocket-rpgkit/src/ui/PlayerSprite.tsx";
import { DialogBox } from "../../vendor/pocket-rpgkit/src/ui/DialogBox.tsx";
import { TileTextureCache } from "../../vendor/pocket-rpgkit/src/ui/tile-texture-cache.ts";
import { WANDER_LOOKS, WANDER_PLAYER } from "./assets-wander.ts";
import { lookFor, lookFromId, lookId, parseVillagerId, playerLook } from "./looks.ts";
import { RenderRing, OVERSCAN_LEAD, OVERSCAN_TRAIL, TILE } from "./wander-render.ts";
import { TAKEOVER, WanderSim, type ScheduledInput, type WanderMode } from "./wander-sim.ts";
import { BIOME_NAMES, CHUNK, biomeAt } from "./world.ts";
import { noticeRect } from "./hud.ts";
import { seedHex } from "./window.ts";
import { regionName } from "./region.ts";
import type { ChunkState } from "./residency.ts";

const PSP_W = 480;
const PSP_H = 272;
const MM_COLS = 11;
const MM_ROWS = 7;
const MM_CELL = 6;
const MM_STEP = MM_CELL + 1;
const MM_W = MM_COLS * MM_STEP - 1;
const MM_H = MM_ROWS * MM_STEP - 1;
const RING_PLATE_W = 128;
const HUD_EVERY = 6;
const NOTICE_FRAMES_SECONDS = 2;

const STATE_COLOR: Record<ChunkState, string> = {
  rendered: "#8ee06f",
  resident: "#3d7f4a",
  queued: "#e8b33e",
  evicted: "#b3474f",
  none: "#1b2638",
};

declare global {
  // eslint-disable-next-line no-var
  var __wanderState: WanderPublished | undefined;
  // eslint-disable-next-line no-var
  var __wanderSim: WanderSim | undefined;
  // eslint-disable-next-line no-var
  var __wanderSeed: number | undefined;
  // eslint-disable-next-line no-var
  var __wanderFast: boolean | undefined;
  /** Test hook: every live input this session enqueued, in firing order —
   *  a scheduled tape that replays the session tick-for-tick at any Hz. */
  // eslint-disable-next-line no-var
  var __wanderTape: ScheduledInput[] | undefined;
  /** Benchmark hook: record a per-phase wall-clock breakdown each frame. */
  // eslint-disable-next-line no-var
  var __wanderPerfOn: boolean | undefined;
  // eslint-disable-next-line no-var
  var __wanderPerf: Record<string, number> | undefined;
  /** Test hook: generation units per reference tick. */
  // eslint-disable-next-line no-var
  var __wanderBudget: number | undefined;
  /** Player look override: "tiny16" for the Sharm walker, or a look id
   *  number from the WANDER_LOOKS pool. Undefined: the pool look the seed
   *  picks (playerLook). Read once per session/reseed. */
  // eslint-disable-next-line no-var
  var __wanderPlayerLook: string | number | undefined;
  /** Test hook: set to an object to record each visible villager's look id
   *  and screen position (updated every frame while assigned). */
  // eslint-disable-next-line no-var
  var __wanderVillagerLooks: Record<string, { lookId: number; sx: number; sy: number }> | undefined;
  /** Test hook: a count of villager look resolutions (parseVillagerId plus
   *  lookFor). A look is resolved once, when the villager's node is born,
   *  and cached on the record; steady frames with a stable visible set add
   *  zero. Set it to 0 before boot to start counting. */
  // eslint-disable-next-line no-var
  var __wanderLookResolves: number | undefined;
}

export interface WanderPublished {
  seed: number; frame: number; now: number; mode: WanderMode; fast: boolean;
  x: number; y: number; windowX: number; windowY: number;
  resident: number; cap: number; queued: number; bytes: number;
  generatedLastSecond: number; generatedTotal: number; evictedTotal: number;
  mounted: number; visible: number; dropped: number; nodeCap: number;
  recentres: number; towns: number; walked: number; units: number; budget: number;
  maxFrameUnits: number; budgetViolations: number; growing: number; seen: number;
  helped: number; errand: string;
}

interface Viewport { w: number; h: number }

function modeLabel(mode: WanderMode, sim: WanderSim): string {
  if (mode === "manual") return "YOU";
  if (mode === "goto") return "WALK TO TAP";
  const t = sim.driver.target;
  if (t?.landmark) return "AUTO > LANDMARK";
  return t?.town ? `AUTO > ${regionName(sim.seed, t.rx, t.ry).toUpperCase()}` : "AUTO WANDER";
}

export function WanderView() {
  const hz = simulationHz();
  const initial = hostViewport(getOps());
  let vp: Viewport = initial ? { ...initial } : { w: PSP_W, h: PSP_H };
  const [viewport, setViewport] = createSignal<Viewport>(vp);
  const perfClock = globalThis.__wanderPerfOn
    ? (globalThis.performance ? () => globalThis.performance.now() : () => Date.now())
    : undefined;
  const budget = globalThis.__wanderBudget;
  const sim = new WanderSim({ seed: globalThis.__wanderSeed ?? 0x5eed_0001, hz, viewW: vp.w, viewH: vp.h, fast: globalThis.__wanderFast === true, budget, clock: perfClock });
  globalThis.__wanderSim = sim;
  // Every live input is enqueued on the sim's tape at this host frame's
  // first reference tick, so live play and replays share one code path; the
  // recording is the exportable scheduled tape.
  const recorded: ScheduledInput[] = [];
  globalThis.__wanderTape = recorded;
  const enqueue = (ev: ScheduledInput) => { sim.enqueue(ev); recorded.push(ev); };
  let liveMask = 0;
  enqueue({ at: 0, buttons: 0 });
  // Set while this host frame's inputs cross a reseed (SQUARE, or a seed-plate
  // tap). A reseed restarts the session clock at 0, so the rest of the frame's
  // mask changes and taps are enqueued at the new session's tick 0 — not at
  // the old session's `sim.now`, which would park them at the tape's front
  // until the new session caught up and drop short presses. Reset per frame.
  let frameReseeded = false;
  // SQUARE (and a seed-plate tap): rebuild the world at this frame's first
  // reference tick. The held mask carries into the new session (the sim
  // preserves it across a reseed), so it is not re-queued here.
  const reseedNow = () => {
    enqueue({ at: sim.now, reseed: true });
    frameReseeded = true;
  };
  // Enqueue a live input at the current epoch's tick: the frame's first
  // reference tick, or tick 0 of the new session when the frame reseeded.
  const enqueueLive = (ev: { buttons?: number; goto?: { x: number; y: number } }) => {
    enqueue({ at: frameReseeded ? 0 : sim.now, ...ev });
  };
  // The sim rebuilds the world in place on a scheduled reseed; re-point the
  // view at the new residency, exactly like a fresh boot.
  sim.onReseed = () => {
    const s = sim.playerTile;
    ring.reset(sim.res, sim.seed, Math.floor(s.x / CHUNK) * CHUNK, Math.floor(s.y / CHUNK) * CHUNK);
    for (const [id, rec] of npcs) { releaseLook(rec.node, rec); npcFree.push(rec.node); npcs.delete(id); }
    if (playerTileRef !== null) { getOps().setImage(player.id, -1); lookCache.release(playerTileRef); playerTileRef = null; }
    playerTileIdx = -1;
    playerSrc = null;
    playerSel = pickPlayerSel();
    playerX = NaN; playerY = NaN;
    shownModal = null;
    lastMode = sim.mode;
    lastLogVersion = -1;
    lastEventVersion = 0;
    lastImprovedVersion = 0;
    journalIdx = 0;
    batch(() => { setSeedText(`SEED 0x${seedHex(sim.seed)}`); setModal(null); });
  };

  // -- world --------------------------------------------------------------
  const frameRoot = createElement("view");
  setProp(frameRoot, "style", { posType: 1, insetL: 0, insetT: 0, width: vp.w, height: vp.h });
  setProp(frameRoot, "debugName", "wander-frame");
  const ring = new RenderRing(frameRoot, sim.res, sim.seed, () => sim.now);
  const start = sim.playerTile;
  ring.reset(sim.res, sim.seed, Math.floor(start.x / CHUNK) * CHUNK, Math.floor(start.y / CHUNK) * CHUNK);
  const cols = (w: number) => Math.ceil(w / TILE) + OVERSCAN_LEAD + OVERSCAN_TRAIL + 1;
  ring.resize(cols(vp.w), cols(vp.h));

  const player = createElement("image");
  setProp(player, "style", { posType: 1, insetL: 0, insetT: 0, width: TILE, height: TILE });
  setProp(player, "debugName", "wander-player");
  insertNode(ring.sprites, player);
  let playerSrc: string | null = null;
  let playerTileRef: string | null = null;
  let playerTileIdx = -1;
  let playerX = NaN, playerY = NaN;
  // The player's walker: a pool look by default (playerLook(seed)), drawn
  // from the look TILESETs, or the Sharm "Tiny 16" set (eager ui:img
  // strings) when __wanderPlayerLook === "tiny16". Re-picked per reseed.
  const pickPlayerSel = (): { kind: "tiles"; base: number; palette: number } | { kind: "strings"; frames: PlayerFrames } => {
    const override = globalThis.__wanderPlayerLook;
    if (override === "tiny16") return { kind: "strings", frames: WANDER_PLAYER };
    if (typeof override === "number") return { kind: "tiles", ...lookFromId(override) };
    return { kind: "tiles", ...playerLook(sim.seed) };
  };
  let playerSel = pickPlayerSel();
  // Bounded LRU for the CLUT8 walker frames: a town shows a handful of
  // residents, each holding one frame at a time, and a walk cycle's frames
  // stay warm between steps. Eviction frees the host texture.
  const lookCache = new TileTextureCache({ maxEntries: 64, maxBytes: 96 * 1024 });
  // WalkPose (0 idle, 1 walkL, 2 walkR) -> the manifest's frames key.
  const LOOK_POSE_KEY = ["idle", "walkL", "walkR"] as const;
  // A resident's look is resolved once, when its node is born, and cached on
  // the record: (seed, town, villager index) is fixed for the id, and a
  // reseed clears the table, so a steady frame only compares the cached tile.
  const npcs = new Map<string, { node: NodeMirror; x: number; y: number; live: boolean; villager: boolean; lookId: number; tileRef: string | null; tileIdx: number }>();
  const npcFree: NodeMirror[] = [];
  /** Detach a record's borrowed tile texture from its node and release it. */
  const releaseLook = (node: NodeMirror, rec: { tileRef: string | null; tileIdx: number }): void => {
    if (rec.tileRef === null) return;
    getOps().setImage(node.id, -1);
    lookCache.release(rec.tileRef);
    rec.tileRef = null;
    rec.tileIdx = -1;
  };

  // -- HUD state ------------------------------------------------------------
  const [seedText, setSeedText] = createSignal(`SEED 0x${seedHex(sim.seed)}`);
  const [posText, setPosText] = createSignal("");
  const [modeText, setModeText] = createSignal("");
  const [resText, setResText] = createSignal("");
  const [genText, setGenText] = createSignal("");
  const [nodeText, setNodeText] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [logText, setLogText] = createSignal("");
  const [errandText, setErrandText] = createSignal("");
  const [modal, setModal] = createSignal<Modal | null>(null);
  let shownModal: Modal | null = null;
  let noticeUntil = 0;
  let lastMode: WanderMode = sim.mode;
  let hudTimer = 0;
  let prevButtons = 0;
  let prevTouchIds = new Set<number>();
  let mouseDown = false;
  let lastLogVersion = -1;
  let lastEventVersion = 0;
  let lastImprovedVersion = 0;
  let journalIdx = 0;

  // Minimap: chunk cells, the player dot and the ring outlines.
  const mmRoot = createElement("view");
  setProp(mmRoot, "style", { posType: 1, insetL: (RING_PLATE_W - MM_W) >> 1, insetT: 4, width: MM_W, height: MM_H });
  setProp(mmRoot, "debugName", "wander-minimap");
  const mmCells: { node: NodeMirror; color: string }[] = [];
  for (let r = 0; r < MM_ROWS; r++) for (let c = 0; c < MM_COLS; c++) {
    const node = createElement("view");
    setProp(node, "style", { posType: 1, insetL: c * MM_STEP, insetT: r * MM_STEP, width: MM_CELL, height: MM_CELL, bgColor: STATE_COLOR.none });
    insertNode(mmRoot, node);
    mmCells.push({ node, color: STATE_COLOR.none });
  }
  const outline = (color: string) => {
    const node = createElement("view");
    setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: 1, height: 1, borderWidth: 1, borderColor: color });
    insertNode(mmRoot, node);
    return { node, w: 1, h: 1, x: NaN, y: NaN };
  };
  const unloadBox = outline("#6f5a8e");
  const loadBox = outline("#e8e2b0");
  const dot = createElement("view");
  setProp(dot, "style", { posType: 1, insetL: 0, insetT: 0, width: 3, height: 3, bgColor: "#ffffff" });
  insertNode(mmRoot, dot);
  // Gold dots for discovered landmarks (pooled; only in-window ones show).
  const LM_DOTS = 16;
  const lmDots: NodeMirror[] = [];
  for (let d = 0; d < LM_DOTS; d++) {
    const node = createElement("view");
    setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: 2, height: 2, bgColor: "#ffd75e" });
    insertNode(mmRoot, node);
    lmDots.push(node);
  }

  const setBox = (b: ReturnType<typeof outline>, x: number, y: number, w: number, h: number) => {
    x = Math.round(x); y = Math.round(y); w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (w !== b.w || h !== b.h) { setProp(b.node, "style", { width: w, height: h }, { width: b.w, height: b.h }); b.w = w; b.h = h; }
    if (x !== b.x) { jump(b.node, "translateX", x); b.x = x; }
    if (y !== b.y) { jump(b.node, "translateY", y); b.y = y; }
  };

  const updateMinimap = () => {
    const f = sim.focus;
    const fcx = Math.floor(f.x / CHUNK), fcy = Math.floor(f.y / CHUNK);
    const c0 = fcx - (MM_COLS >> 1), r0 = fcy - (MM_ROWS >> 1);
    const cam = camera();
    const render = { x0: Math.floor(cam.x / TILE) - OVERSCAN_LEAD, y0: Math.floor(cam.y / TILE) - OVERSCAN_LEAD, x1: Math.floor((cam.x + vp.w) / TILE) + OVERSCAN_TRAIL, y1: Math.floor((cam.y + vp.h) / TILE) + OVERSCAN_TRAIL };
    for (let r = 0; r < MM_ROWS; r++) for (let c = 0; c < MM_COLS; c++) {
      const cell = mmCells[r * MM_COLS + c]!;
      const color = STATE_COLOR[sim.res.chunkState(c0 + c, r0 + r, render)];
      if (color !== cell.color) { setProp(cell.node, "style", { bgColor: color }, { bgColor: cell.color }); cell.color = color; }
    }
    const toMap = (tx: number, ty: number) => ({ x: (tx / CHUNK - c0) * MM_STEP, y: (ty / CHUNK - r0) * MM_STEP });
    const { load, unload } = sim.res.rings;
    const clampBox = (b: ReturnType<typeof outline>, rect: typeof load) => {
      const a = toMap(rect.x0, rect.y0), z = toMap(rect.x1 + 1, rect.y1 + 1);
      const x = Math.max(-1, a.x), y = Math.max(-1, a.y);
      setBox(b, x, y, Math.min(MM_W + 1, z.x) - x, Math.min(MM_H + 1, z.y) - y);
    };
    clampBox(unloadBox, unload);
    clampBox(loadBox, load);
    const p = toMap(sim.playerTile.x + 0.5, sim.playerTile.y + 0.5);
    jump(dot, "translateX", Math.round(p.x) - 1);
    jump(dot, "translateY", Math.round(p.y) - 1);
    // Discovered landmarks inside the minimap window get a gold dot.
    let di = 0;
    for (const v of sim.log.found.values()) {
      const m = toMap(v.x + 0.5, v.y + 0.5);
      if (m.x < -2 || m.y < -2 || m.x > MM_W + 2 || m.y > MM_H + 2) continue;
      if (di >= LM_DOTS) break;
      jump(lmDots[di]!, "translateX", Math.round(m.x) - 1);
      jump(lmDots[di]!, "translateY", Math.round(m.y) - 1);
      di++;
    }
    for (; di < LM_DOTS; di++) { jump(lmDots[di]!, "translateX", -4); jump(lmDots[di]!, "translateY", -4); }
  };

  const camera = () => {
    const p = sim.playerPx;
    return { x: Math.floor(p.x + TILE / 2 - vp.w / 2), y: Math.floor(p.y + TILE / 2 - vp.h / 2) };
  };

  const syncPeople = () => {
    const s = sim.state;
    const ox = (sim.window.x0 - ring.ox) * TILE, oy = (sim.window.y0 - ring.oy) * TILE;
    const pose = walkPose(s.move.phase);
    if (playerSel.kind === "tiles") {
      const look = WANDER_LOOKS[lookId(playerSel)]!;
      const idx = look.frames[LOOK_POSE_KEY[pose]!][s.move.facing]!;
      if (idx !== playerTileIdx) {
        if (playerTileRef !== null) { getOps().setImage(player.id, -1); lookCache.release(playerTileRef); }
        if (playerSrc !== null) { setProp(player, "src", null, playerSrc); playerSrc = null; }
        const ref = `${look.tileset}#${idx}`;
        const handle = lookCache.acquire({ kind: "tile", ref, sourceWidth: TILE, sourceHeight: TILE });
        getOps().setImage(player.id, handle);
        playerTileRef = ref;
        playerTileIdx = idx;
      }
    } else {
      const src = playerImageKey(pose, s.move.facing, playerSel.frames);
      if (src !== playerSrc) {
        if (playerTileRef !== null) { getOps().setImage(player.id, -1); lookCache.release(playerTileRef); playerTileRef = null; playerTileIdx = -1; }
        setProp(player, "src", src, playerSrc);
        playerSrc = src;
      }
    }
    const px = ox + s.move.px, py = oy + s.move.py;
    if (px !== playerX) { jump(player, "translateX", px); playerX = px; }
    if (py !== playerY) { jump(player, "translateY", py); playerY = py; }
    for (const rec of npcs.values()) rec.live = false;
    const cam = camera();
    const camRx = (cam.x - ring.ox * TILE), camRy = (cam.y - ring.oy * TILE);
    for (const id in s.chars.chars) {
      const ch = s.chars.chars[id]!;
      if (!ch.visible) continue;
      const x = ox + ch.px, y = oy + ch.py;
      if (x < camRx - TILE || y < camRy - TILE || x > camRx + vp.w || y > camRy + vp.h) continue;
      let rec = npcs.get(id);
      if (!rec) {
        // The resident's look is a pure function of (seed, town, villager
        // index), parsed out of its id once when the node is born; the same
        // villager wears the same face on every machine and every visit,
        // and a steady frame never re-resolves it (a reseed clears the
        // table, so the cached id cannot go stale across worlds).
        const v = parseVillagerId(id);
        const look = v ? lookFor(sim.seed, v.rx, v.ry, v.n) : null;
        if (look && globalThis.__wanderLookResolves !== undefined) globalThis.__wanderLookResolves++;
        let node = npcFree.pop();
        if (!node) {
          node = createElement("image");
          setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: TILE, height: TILE });
          insertNode(ring.sprites, node);
        }
        rec = { node, x: NaN, y: NaN, live: true, villager: look !== null, lookId: look ? lookId(look) : 0, tileRef: null, tileIdx: -1 };
        npcs.set(id, rec);
      }
      rec.live = true;
      if (rec.villager) {
        const idx = WANDER_LOOKS[rec.lookId]!.frames[LOOK_POSE_KEY[walkPose(ch.phase)]!][ch.facing]!;
        if (idx !== rec.tileIdx) {
          releaseLook(rec.node, rec);
          const ref = `${WANDER_LOOKS[rec.lookId]!.tileset}#${idx}`;
          const handle = lookCache.acquire({ kind: "tile", ref, sourceWidth: TILE, sourceHeight: TILE });
          getOps().setImage(rec.node.id, handle);
          rec.tileRef = ref;
          rec.tileIdx = idx;
        }
      } else if (rec.tileRef !== null) {
        releaseLook(rec.node, rec);
      }
      if (x !== rec.x) { jump(rec.node, "translateX", x); rec.x = x; }
      if (y !== rec.y) { jump(rec.node, "translateY", y); rec.y = y; }
    }
    for (const [id, rec] of npcs) {
      if (rec.live) continue;
      releaseLook(rec.node, rec);
      npcFree.push(rec.node);
      npcs.delete(id);
    }
    // Test hook: the visible villagers' looks and screen positions, so a
    // render test can count distinct looks in one scene from the pixels.
    // Screen position = node translate + ring-root offset - camera. Reads
    // the cached birth-time look; the hook itself resolves nothing.
    if (globalThis.__wanderVillagerLooks !== undefined) {
      const out: Record<string, { lookId: number; sx: number; sy: number }> = {};
      const oxScreen = ring.ox * TILE - cam.x, oyScreen = ring.oy * TILE - cam.y;
      for (const [id, rec] of npcs) {
        if (!rec.live || !rec.villager) continue;
        out[id] = { lookId: rec.lookId, sx: Math.round(rec.x + oxScreen), sy: Math.round(rec.y + oyScreen) };
      }
      globalThis.__wanderVillagerLooks = out;
    }
  };

  const publish = () => {
    const st = sim.stats();
    const rs = ring.stats();
    const p = sim.playerTile;
    const out: WanderPublished = globalThis.__wanderState ?? ({} as WanderPublished);
    out.seed = sim.seed; out.frame = sim.frame; out.now = sim.now; out.mode = sim.mode; out.fast = sim.fast;
    out.x = p.x; out.y = p.y; out.windowX = sim.window.x0; out.windowY = sim.window.y0;
    out.resident = st.resident; out.cap = st.cap; out.queued = st.queued; out.bytes = st.bytes;
    out.generatedLastSecond = st.generatedLastSecond; out.generatedTotal = st.generatedTotal; out.evictedTotal = st.evictedTotal;
    out.mounted = rs.mounted + 1 + npcs.size + npcFree.length; out.visible = rs.visible; out.dropped = rs.dropped; out.nodeCap = rs.cap;
    out.recentres = st.recentres; out.towns = sim.driver.arrivedTowns; out.walked = sim.walked; out.units = sim.lastFrame.units; out.budget = sim.lastFrame.budget;
    out.maxFrameUnits = st.maxFrameUnits; out.budgetViolations = st.budgetViolations; out.growing = st.growing; out.seen = st.seenRegions;
    out.helped = sim.helpedCount;
    out.errand = sim.errand ? `${sim.errand.kind}:${sim.errand.targetName}` : "";
    globalThis.__wanderState = out;
    return { st, rs };
  };

  const refreshHud = () => {
    const { st, rs } = publish();
    const p = sim.playerTile;
    batch(() => {
      setPosText(`X ${p.x}  Y ${p.y}  ${BIOME_NAMES[biomeAt(sim.seed, p.x, p.y)]}`);
      // Fast travel replaces AUTO in the label rather than lengthening it, so
      // a long town name still fits the 158 px plate.
      const label = modeLabel(sim.mode, sim);
      setModeText(!sim.fast ? label : label.startsWith("AUTO") ? `FAST${label.slice(4)}` : `${label}  FAST`);
      setResText(`CHUNKS ${st.resident}/${st.cap} ${Math.round(st.bytes / 1024)}K`);
      setGenText(`GEN ${st.generatedLastSecond}/S  Q ${st.queued}`);
      // Live image nodes (the pools also keep a few hidden spares, whose
      // high-water mark depends on the host rate; __wanderState.mounted).
      setNodeText(`NODES ${rs.visible}/${rs.cap}`);
      // Travel log: total discoveries (never decreases) and the nearest rumor.
      const entries = [...sim.log.found.values()];
      const latest = entries.at(-1);
      const rumor = sim.nearestRumor();
      setLogText(`LOG ${sim.log.total} · ${latest ? latest.kind : "—"}    ${rumor ? `RUMOR: ${rumor.kind} ${rumor.dir} ${rumor.dist}` : "RUMOR: nothing nearby"}`);
      // The active errand and the lifetime helped count.
      setErrandText(sim.errand
        ? `ERRAND: ${sim.errand.kind === "visit" ? sim.errand.what : `carry ${sim.errand.what}`} -> ${sim.errand.targetName}   HELPED ${sim.helpedCount}`
        : `ERRAND: none   HELPED ${sim.helpedCount}`);
    });
    updateMinimap();
  };

  const plateW = () => (viewport().w >= 900 ? 206 : 158);
  const tap = (x: number, y: number) => {
    // Seed plate (top-left): a new world. Anywhere else on the field: walk.
    if (x < plateW() + 6 && y < 50) { reseedNow(); return; }
    const cam = camera();
    enqueueLive({ goto: { x: Math.floor((cam.x + x) / TILE), y: Math.floor((cam.y + y) / TILE) } });
  };

  onFrame((buttons) => {
    frameReseeded = false;
    const nextVp = hostViewport(getOps());
    if (nextVp && (nextVp.w !== vp.w || nextVp.h !== vp.h)) {
      vp = { ...nextVp };
      setViewport(vp);
      setProp(frameRoot, "style", { width: vp.w, height: vp.h });
      sim.setViewport(vp.w, vp.h);
      ring.resize(cols(vp.w), cols(vp.h));
    }
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    // Live inputs are sampled once per host frame and enqueued at the frame's
    // first reference tick: the tape is the only input path, so a recorded
    // session replays tick-for-tick at any host rate. A frame that reseeds
    // (SQUARE, or a seed-plate tap) starts a new session clock at 0, so the
    // rest of that frame's inputs are enqueued at tick 0 of the new session
    // (enqueueLive); the held mask carries across without a fresh press edge.
    const live = buttons & ~BTN.SQUARE;
    if (pressed & BTN.SQUARE) reseedNow();
    if (live !== liveMask) { liveMask = live; enqueueLive({ buttons: live }); }
    const ids = new Set<number>();
    for (const t of touches()) {
      ids.add(t.id);
      if (!prevTouchIds.has(t.id)) tap(t.x, t.y);
    }
    prevTouchIds = ids;
    // The desktop host reports the mouse as service lines rather than
    // touches (GrowView reads them the same way): a left-button press is a
    // tap. Hosts without the service channel skip this.
    const lines = getOps().svcPoll?.();
    if (lines) {
      for (const line of lines.split("\n")) {
        if (!line.includes('"t":"mouse"')) continue;
        try {
          const m = JSON.parse(line) as { x?: number | null; y?: number | null; d?: boolean; b?: number };
          const down = m.d === true && m.b !== 2;
          if (down && !mouseDown && m.x != null && m.y != null) tap(m.x, m.y);
          mouseDown = down;
        } catch { /* not a mouse line */ }
      }
    }

    // Opt-in wall-clock probe for the desktop benchmark; the world never
    // reads it.
    const clock = globalThis.__wanderPerfOn ? (globalThis.performance ?? Date) : undefined;
    const t0 = clock?.now() ?? 0;
    sim.step(buttons & ~BTN.SQUARE);
    const t1 = clock?.now() ?? 0;

    const cam = camera();
    const fresh = sim.res.fresh.splice(0);
    const off = ring.update(cam.x, cam.y, fresh);
    jump(ring.root, "translateX", off.x);
    jump(ring.root, "translateY", off.y);
    const t2 = clock?.now() ?? 0;
    syncPeople();
    const t3 = clock?.now() ?? 0;

    const m = sim.state.interp.modal;
    if (modalChanged(shownModal, m)) { shownModal = m ? deepClone(m) : null; setModal(shownModal); }
    if (sim.mode !== lastMode) {
      if (sim.mode === "manual" && buttons & TAKEOVER) { setNotice("YOU HAVE CONTROL"); noticeUntil = sim.now + 60 * NOTICE_FRAMES_SECONDS; }
      else if (sim.mode === "auto") { setNotice("AUTO WANDER"); noticeUntil = sim.now + 60 * NOTICE_FRAMES_SECONDS; }
      lastMode = sim.mode;
    }
    // CROSS (outside dialogs): accept/deliver an errand on a plaza, else
    // page through the travel log.
    if ((pressed & BTN.CROSS) && !sim.state.interp.modal) {
      if (sim.nearPlaza()) {
        sim.pressAction();
        if (sim.eventVersion !== lastEventVersion) {
          lastEventVersion = sim.eventVersion;
          setNotice(sim.lastEvent);
          noticeUntil = sim.now + 60 * NOTICE_FRAMES_SECONDS * 2;
        }
      } else {
        const entries = [...sim.log.found.values()];
        if (entries.length) {
          journalIdx = journalIdx % entries.length;
          const v = entries[journalIdx]!;
          setNotice(`LOG ${journalIdx + 1}/${entries.length}: ${v.kind} @ ${v.name}`);
          noticeUntil = sim.now + 60 * 4;
          journalIdx++;
        } else {
          setNotice("LOG: nothing found yet");
          noticeUntil = sim.now + 60 * 2;
        }
      }
    }
    // A new discovery gets a longer notice (after the step so it is immediate).
    if (sim.log.version !== lastLogVersion) {
      lastLogVersion = sim.log.version;
      if (sim.lastFind) { setNotice(`FOUND: ${sim.lastFind}`); noticeUntil = sim.now + 60 * NOTICE_FRAMES_SECONDS * 2; }
    }
    // An accept/deliver the driver made itself (auto mode) gets a notice.
    if (sim.eventVersion !== lastEventVersion) {
      lastEventVersion = sim.eventVersion;
      setNotice(sim.lastEvent);
      noticeUntil = sim.now + 60 * NOTICE_FRAMES_SECONDS * 2;
    }
    // Plaza flowers: repaint the ring's cells once.
    if (sim.improvedVersion !== lastImprovedVersion) {
      lastImprovedVersion = sim.improvedVersion;
      ring.invalidateAll();
    }
    if (noticeUntil > 0 && sim.now >= noticeUntil) { noticeUntil = 0; setNotice(""); }
    if (++hudTimer >= Math.max(1, Math.round(HUD_EVERY * hz / 60)) || sim.lastFrame.recentred) { hudTimer = 0; refreshHud(); }
    else publish();
    if (clock) globalThis.__wanderPerf = { sim: t1 - t0, ring: t2 - t1, people: t3 - t2, hud: clock.now() - t3, fresh: fresh.length, ...sim.perf, layers: ring.stats().layers.join("/") as unknown as number };
  });
  refreshHud();

  return <View class="w-full h-full overflow-hidden bg-black">
    <View class="absolute overflow-hidden" style={{ posType: 1, insetL: 0, insetT: 0, width: viewport().w, height: viewport().h }} debugName="wander-field">
      {frameRoot as unknown as ReturnType<typeof View>}
    </View>
    <View class="absolute" style={{ posType: 1, insetT: 4, insetL: 6, width: plateW(), height: 43, bgColor: "#0b1626", opacity: 0.84 }} debugName="wander-plate" />
    <Text class="text-xs" style={{ posType: 1, insetT: 6, insetL: 12, textColor: "#ffe97a", lineHeight: 12, height: 12 }}>{seedText()}</Text>
    <Text class="text-xs" style={{ posType: 1, insetT: 19, insetL: 12, textColor: "#9fd0ff", lineHeight: 12, height: 12 }}>{posText()}</Text>
    <Text class="text-xs" style={{ posType: 1, insetT: 32, insetL: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{modeText()}</Text>
    <View class="absolute" style={{ posType: 1, insetT: 4, insetR: 6, width: RING_PLATE_W, height: MM_H + 8 + 42, bgColor: "#0b1626", opacity: 0.84 }} debugName="wander-ringplate">
      {mmRoot as unknown as ReturnType<typeof View>}
    </View>
    <Text class="text-xs" style={{ posType: 1, insetT: MM_H + 13, insetR: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{resText()}</Text>
    <Text class="text-xs" style={{ posType: 1, insetT: MM_H + 26, insetR: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{genText()}</Text>
    <Text class="text-xs" style={{ posType: 1, insetT: MM_H + 39, insetR: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{nodeText()}</Text>
    <Show when={!modal()}>
      <View class="absolute" style={{ posType: 1, insetB: 44, insetL: 6, insetR: 6, height: 16, bgColor: "#0b1626", opacity: 0.76 }} debugName="wander-logline" />
      <Text class="text-xs" style={{ posType: 1, insetB: 46, insetL: 12, textColor: "#ffe97a", lineHeight: 12, height: 12 }}>{logText()}</Text>
      <View class="absolute" style={{ posType: 1, insetB: 24, insetL: 6, insetR: 6, height: 16, bgColor: "#0b1626", opacity: 0.76 }} debugName="wander-errandline" />
      <Text class="text-xs" style={{ posType: 1, insetB: 26, insetL: 12, textColor: "#ffb37a", lineHeight: 12, height: 12 }}>{errandText()}</Text>
      <View class="absolute" style={{ posType: 1, insetB: 4, insetL: 6, width: 300, height: 16, bgColor: "#0b1626", opacity: 0.76 }} debugName="wander-help" />
      <Text class="text-xs" style={{ posType: 1, insetB: 6, insetL: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>SQR SEED  TRI FAST  SEL AUTO  X ACT/LOG</Text>
    </Show>
    <Show when={notice() !== ""}>
      <View class="absolute flex-row justify-center" style={{ posType: 1, insetT: noticeRect(viewport().w, viewport().h).y0, insetL: 0, insetR: 0 }} debugName="wander-notice">
        <View style={{ bgColor: "#0b1626", paddingL: 10, paddingR: 10, paddingT: 2, paddingB: 2 }}>
          <Text class="text-sm" style={{ textColor: "#8ad0ff", lineHeight: 18, height: 18 }}>{notice()}</Text>
        </View>
      </View>
    </Show>
    <DialogBox modal={modal} legend={() => (modal() ? "next" : "")} />
  </View>;
}
