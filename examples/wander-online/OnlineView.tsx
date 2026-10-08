// examples/wander-online/OnlineView.tsx — the wander-online world on screen.
//
// Three screens, one account:
//   gate       web: "sign in with GitHub on this page"; desktop: enter a
//              6-digit link code from a signed-in web client. No socket.
//   creating   first sign-in: pick a name (the built-in name-input rules)
//              default = GitHub login) and a look from the 64-entry W-CHAR
//              pool, with a large animated preview.
//   world      the shared frozen wander window, drawn with the single-
//              player render ring (real terrain, roads, stamps): the local
//              player is predicted and centred under the camera, remote
//              players walk and show name labels, with a SELECT menu for
//              linking a device, deleting the profile, and signing out.
//
// The net client (net/client.ts) owns the socket, prediction and
// interpolation; this view presents it and drives the auth handshake.

import { batch, createSignal, Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createElement, insertNode, setProp } from "@pocketjs/framework/renderer";
import { jump } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { after, simulationHz } from "@pocketjs/framework/clock";
import { BTN, touches } from "@pocketjs/framework/input";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { getText } from "@pocketjs/framework/pak";
import { WINDOW } from "../wander/window.ts";
import { RenderRing, OVERSCAN_LEAD, OVERSCAN_TRAIL, TILE } from "../wander/wander-render.ts";
import { WANDER_LOOKS } from "../wander/assets-wander.ts";
import {
  LOOK_COUNT,
  cycleLookBase,
  cycleLookPalette,
  lookFor,
  lookId,
  parseVillagerId,
} from "../wander/looks.ts";
import { walkPose } from "../../src/engine/movement.ts";
import { TileTextureCache } from "../../src/ui/tile-texture-cache.ts";
import { nameInputRules, type NameInputState } from "../../src/engine/name-input.ts";
import { CreateCharScene, type CreateFocus } from "./CreateCharScene.tsx";
import {
  gateRect,
  helpRect,
  linkGateRect,
  linkHintRect,
  linkPadCell,
  menuRect,
  noticeRect,
  statusPlate,
  type HudRect,
} from "./hud.ts";
import { createLayout, createNameGrid } from "./hud.ts";
import type { ArenaWorld } from "./net/world.ts";
import { OnlineClient, type AuthCredential, type SocketFactory } from "./net/client.ts";
import type { RosterEntry } from "./net/protocol.ts";
import { loadTicket, saveTicket, clearTicket } from "./auth-store.ts";
import { AUTH_PROTOCOL_VERSION } from "./shared/auth.ts";
import { LINK_PAD_KEYS, stepLinkCode, type LinkCodeState } from "./link-code.ts";

type OnlineClientOptsSocketFactory = SocketFactory | undefined;

const PSP_W = 480;
const PSP_H = 272;
const WORLD_PX = WINDOW * TILE;
const IDLE_RESUME_SECONDS = 10;
const HUD_EVERY = 6;
const AUTO_DIRS = [BTN.UP, BTN.RIGHT, BTN.DOWN, BTN.LEFT] as const;
const NO_FRESH_CHUNKS: readonly never[] = [];

declare global {
  // eslint-disable-next-line no-var
  var __onlineState: OnlinePublished | undefined;
  // eslint-disable-next-line no-var
  var __onlinePerfOn: boolean | undefined;
  // eslint-disable-next-line no-var
  var __onlinePerf: Record<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __onlineUrl: string | undefined;
  /** Test hook: inject a socket factory (sim tests). */
  // eslint-disable-next-line no-var
  var __onlineSocketFactory: OnlineClientOptsSocketFactory | undefined;
  /** Test hook: inject an auth credential (sim tests). */
  // eslint-disable-next-line no-var
  var __onlineAuth: AuthCredential | undefined;
  /** Test hook: remote-node pool churn (births + recycles since boot). A
   *  steady scene must not increase it. */
  // eslint-disable-next-line no-var
  var __onlineNodeChurn: number | undefined;
  /** Test hook: array materializations from Interpolator.ids(). */
  // eslint-disable-next-line no-var
  var __onlineArrayAllocations: number | undefined;
  /** Test hook: visible resident positions used to force a deterministic
   *  nameplate/sprite overlap in the sim renderer. Production leaves it
   *  undefined, so the render path does not materialize this object. */
  // eslint-disable-next-line no-var
  var __onlineVillagerPositions: Record<string, {
    look: number;
    pose: number;
    facing: number;
    x: number;
    y: number;
    sx: number;
    sy: number;
  }> | undefined;
  /** Test/screenshot hook: observe residents without mounting their sprite
   *  nodes yet, so a later mount can prove nameplates are a separate layer. */
  // eslint-disable-next-line no-var
  var __onlineDeferVillagers: boolean | undefined;
  /** Set by the web player page after the GitHub OAuth redirect: the
   *  one-time GitHub token. The game swaps it for a ticket and the page
   *  never persists it. */
  // eslint-disable-next-line no-var
  var __pocketAuth: { token?: string } | undefined;
  /** Explicitly installed by the browser player before loading assets. */
  // eslint-disable-next-line no-var
  var __pocketWeb: boolean | undefined;
  /** The game installs this so the page can show "Signed in as X". */
  // eslint-disable-next-line no-var
  var __pocketAuthEvent: ((ev: { type: "login"; login: string } | { type: "logout" }) => void) | undefined;
  /** The page calls this to sign out. */
  // eslint-disable-next-line no-var
  var __pocketAuthCommand: ((cmd: "signout") => void) | undefined;
}

export interface OnlinePublished {
  status: string;
  screen: string;
  myId: number;
  /** Players in the current room (the historical diagnostics field). */
  online: number;
  /** Players across all rooms; equals `online` with a legacy server. */
  allOnline: number;
  rtt: number;
  corrections: number;
  unacked: number;
  x: number;
  y: number;
  moving: boolean;
  auto: boolean;
  login: string;
  /** The rejection text from the last createError, "" when creation is not
   *  in a rejected state. */
  createError: string;
  notice: string;
  look: number;
  linkCode: string;
  linkCursor: number;
  villagers: number;
  roster: Record<number, { name: string; look: number }>;
  remote: { id: number; x: number; y: number }[];
}

const DEFAULT_URL = "ws://127.0.0.1:8080/ws";

/** Short user-facing text per server createError reason (the NameError
 *  codes in shared/auth.ts). Kept terse so it fits the creation screen's
 *  footer. */
const CREATE_ERROR_TEXT: Record<string, string> = {
  "name-empty": "Name is empty.",
  "name-too-long": "Name is too long.",
  "name-charset": "Name has invalid characters.",
  "name-blocked": "Name is not allowed.",
};

function describeCreateError(reason: unknown): string {
  return CREATE_ERROR_TEXT[String(reason ?? "")] ?? "Name was rejected.";
}

function resolveUrl(injected: string | undefined): string {
  if (injected) return injected;
  try {
    const cfg = JSON.parse(getText("online-config.json")) as { url?: unknown };
    if (typeof cfg.url === "string" && cfg.url.length > 0) return cfg.url;
  } catch {
    // No config entry in the pak (older builds): fall through to default.
  }
  return DEFAULT_URL;
}

/** A bounded auto-walk driver (same as the pre-auth demo). */
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
        this.held = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? BTN.RIGHT : BTN.LEFT) : (dy > 0 ? BTN.DOWN : BTN.UP);
      } else {
        this.held = Math.random() < 0.2 ? 0 : AUTO_DIRS[Math.floor(Math.random() * 4)]!;
      }
      this.nextChange = t + 800 + Math.random() * 1500;
    }
    return this.held;
  }
  reset(): void {
    this.nextChange = 0;
  }
}

type Screen = "gate" | "creating" | "world";

/** Absolute rect in screen px -> a style with screen-px insets. */
function rect(style: HudRect): Record<string, number> {
  return { posType: 1, insetL: style.x0, insetT: style.y0, width: style.x1 - style.x0, height: style.y1 - style.y0 };
}

interface SpriteRec {
  tileRef: string | null;
  tileIdx: number;
}

interface VillagerRec extends SpriteRec {
  node: NodeMirror;
  x: number;
  y: number;
  live: boolean;
  lookId: number;
}

interface Viewport {
  w: number;
  h: number;
}

export function OnlineView() {
  const hz = simulationHz();
  const g = globalThis as {
    __onlineUrl?: string;
    __onlineSocketFactory?: OnlineClientOptsSocketFactory;
    __onlineAuth?: AuthCredential;
    __pocketAuth?: { token?: string };
    __pocketWeb?: boolean;
  };
  const url = resolveUrl(g.__onlineUrl);

  // -- viewport (follows the host, like the single-player wander view) ------
  const initialVp = hostViewport(getOps());
  let vp: Viewport = initialVp ? { ...initialVp } : { w: PSP_W, h: PSP_H };
  const [viewport, setViewport] = createSignal<Viewport>(vp);

  // -- auth bootstrap -------------------------------------------------------
  const pageToken = g.__pocketAuth?.token;
  const storedTicket = loadTicket();
  const isDesktop = g.__pocketWeb !== true;
  const initialAuth: AuthCredential | null = pageToken
    ? { kind: "github", token: pageToken }
    : storedTicket
      ? { kind: "ticket", ticket: storedTicket }
      : g.__onlineAuth ?? null;

  const [screen, setScreen] = createSignal<Screen>(initialAuth ? "world" : "gate");
  const [login, setLogin] = createSignal("");
  const [statusText, setStatusText] = createSignal("connecting");
  const [nameLine, setNameLine] = createSignal("");
  const [debugText, setDebugText] = createSignal("");
  const [posText, setPosText] = createSignal("");
  const [gateText, setGateText] = createSignal("");
  const [codeDisplay, setCodeDisplay] = createSignal("");
  const [linkCursor, setLinkCursor] = createSignal(0);
  const [menuOpen, setMenuOpen] = createSignal(false);
  /** Delete-profile confirmation: the first SQUARE arms it, the second
   *  (within the window) sends the delete. Destructive, so never one press. */
  const [deleteArmed, setDeleteArmed] = createSignal(false);
  let deleteArmedAt = 0;
  const [notice, setNotice] = createSignal("");
  const [lookSel, setLookSel] = createSignal(0);
  const [createError, setCreateError] = createSignal("");
  const [debugOn, setDebugOn] = createSignal(false);
  const [focusSig, setFocusSig] = createSignal<CreateFocus>("name");

  let client: OnlineClient | null = null;
  let noticeUntil = 0;
  let createFocus: CreateFocus = "name";
  const roster = new Map<number, RosterEntry>();
  const publishedRoster: Record<number, { name: string; look: number }> = {};

  const showNotice = (text: string, ms = 3000) => {
    setNotice(text);
    noticeUntil = Date.now() + ms;
  };

  /** Map a deleteError reason token to a player-facing line. A failed
   *  delete never signs the player out: the profile is still theirs. */
  const deleteErrorText = (reason: string): string => {
    switch (reason) {
      case "ticket":
        return "Delete failed: sign in again";
      case "delete-unavailable":
        return "Delete unavailable: try again later";
      default:
        return "Delete failed";
    }
  };

  const publishLogin = (name: string) => {
    setLogin(name);
    try {
      globalThis.__pocketAuthEvent?.({ type: "login", login: name });
    } catch {
      // no page (desktop)
    }
  };

  const signOut = () => {
    clearTicket();
    try {
      globalThis.__pocketAuthEvent?.({ type: "logout" });
    } catch {
      // no page
    }
    client?.stop();
    client = null;
    roster.clear();
    setMenuOpen(false);
    setScreen("gate");
    setGateText("Signed out. Sign in again to play.");
  };
  try {
    globalThis.__pocketAuthCommand = (cmd) => {
      if (cmd === "signout") signOut();
    };
  } catch {
    // desktop
  }

  // -- character creation state ---------------------------------------------
  const makeNameState = (defaultName: string): NameInputState => {
    const started = nameInputRules.start(
      null,
      { default: defaultName || "player", maxLength: 12, title: "Your Name" },
      0,
      { variables: {}, playerName: "" } as never,
    );
    return (started?.state ?? { buffer: defaultName, cursor: 0 }) as unknown as NameInputState;
  };
  let ns: NameInputState = makeNameState(login() || "player");
  const [nameState, setNameState] = createSignal<NameInputState>(ns);
  let creating = false;

  const startClient = (auth: AuthCredential) => {
    client?.stop();
    client = new OnlineClient(url, {
      auth,
      name: auth.kind === "guest" ? auth.name : undefined,
      color: auth.kind === "guest" ? auth.color : undefined,
      socketFactory: g.__onlineSocketFactory,
      onTicket: (ticket) => saveTicket(ticket),
      onNeedCreate: (loginName, ticket) => {
        publishLogin(loginName);
        ns = makeNameState(loginName);
        setNameState({ ...ns });
        createFocus = "name";
        setFocusSig("name");
        setScreen("creating");
      },
      onRoster: (entries) => {
        for (const id in publishedRoster) delete publishedRoster[id];
        for (const e of entries) {
          roster.set(e.id, e);
          publishedRoster[e.id] = { name: e.name, look: e.look };
          if (e.id === client?.myId) publishLogin(e.name);
        }
        if (client?.myId) setScreen("world");
      },
      onText: (msg) => {
        if (msg.type === "linked" && typeof msg.login === "string") publishLogin(msg.login);
        if (msg.type === "deleted") {
          showNotice("Profile deleted");
          // The guest realm has no setTimeout; after() fires on a virtual
          // frame (OnlineView is the app root and never unmounts).
          after(1.5, signOut);
        } else if (msg.type === "deleteError") {
          // The server refused or could not confirm the delete: stay
          // signed in and say why (the profile was NOT removed).
          showNotice(deleteErrorText(String(msg.reason ?? "")));
        } else if (msg.type === "createOk") {
          // Profile created: re-JOIN with the ticket to enter the world.
          creating = false;
          setCreateError("");
          setScreen("world");
          client?.rejoin();
        } else if (msg.type === "createError") {
          // The server refused this name/look: release the submit lock and
          // re-arm the name-input scene (OK left it in its "done" phase,
          // which would auto-resubmit every frame) so the player can fix
          // the name and try again. The entered buffer and chosen look are
          // kept.
          creating = false;
          ns = makeNameState(ns.buffer);
          setCreateError(describeCreateError(msg.reason));
        } else if (msg.type === "linkCode") {
          showNotice(`Link code: ${msg.code} (5 min)`, 30000);
        } else if (msg.type === "linkError") {
          codeState = { code: "", cursor: 0 };
          setCodeDisplay("");
          setLinkCursor(0);
          setGateText("Code invalid or expired. Enter a new code.");
          setScreen("gate");
        }
      },
    });
    setScreen(auth.kind === "link" ? "gate" : "world");
  };

  if (initialAuth) startClient(initialAuth);

  setGateText(
    isDesktop
      ? "Enter a link code from a signed-in web client"
      : pageToken
        ? "Signing in with GitHub…"
        : storedTicket
          ? "Connecting…"
          : "Sign in with GitHub using the button on this page",
  );

  // -- desktop link-code entry ------------------------------------------------
  let codeState: LinkCodeState = { code: "", cursor: 0 };
  const applyLinkAction = (action: Parameters<typeof stepLinkCode>[1]) => {
    const result = stepLinkCode(codeState, action);
    codeState = result.state;
    setCodeDisplay(codeState.code);
    setLinkCursor(codeState.cursor);
    if (result.submit) submitCode(result.submit);
  };
  const submitCode = (code: string) => {
    if (code.length !== 6) return;
    setGateText("Linking device…");
    startClient({ kind: "link", code });
  };

  const submitCreate = () => {
    if (creating || !client) return;
    const c = client;
    const done = nameInputRules.done(ns as never);
    if (!done || done.cancelled) return;
    const name = (done as { playerName?: string }).playerName ?? "";
    if (!name) return;
    creating = true;
    setCreateError("");
    const ticket = c.auth.kind === "ticket" ? c.auth.ticket : loadTicket() ?? "";
    c.sendText(JSON.stringify({ type: "create", v: 3, ticket, name, look: lookSel() }));
  };

  // -- world rendering ----------------------------------------------------------
  const fieldRoot = createElement("view");
  setProp(fieldRoot, "style", { posType: 1, insetL: 0, insetT: 0, width: vp.w, height: vp.h });
  setProp(fieldRoot, "debugName", "online-field");

  let ring: RenderRing | null = null;
  let ringWorld: ArenaWorld | null = null;
  /** Labels live above the ring's ground, sprites, residents and upper
   *  terrain layers. Keeping them out of `sprites` also prevents a later
   *  player sprite from covering an earlier player's name. */
  let nameOverlay: NodeMirror | null = null;
  const ringCols = () => Math.ceil(vp.w / TILE) + OVERSCAN_LEAD + OVERSCAN_TRAIL + 1;
  const ringRows = () => Math.ceil(vp.h / TILE) + OVERSCAN_LEAD + OVERSCAN_TRAIL + 1;
  const ensureRing = (world: ArenaWorld) => {
    if (ring && ringWorld === world) return;
    ringWorld = world;
    if (!ring) {
      ring = new RenderRing(fieldRoot, world.res, world.seed, () => ringWorld?.bootNow ?? 0);
      ring.resize(ringCols(), ringRows());
      nameOverlay = createElement("view");
      setProp(nameOverlay, "style", { posType: 1, insetL: 0, insetT: 0, width: 0, height: 0 });
      setProp(nameOverlay, "debugName", "online-name-overlay");
      // RenderRing constructs `upper` last. Appending this container to the
      // ring root therefore makes every name the final world-space layer.
      insertNode(ring.root, nameOverlay);
    }
    ring.reset(world.res, world.seed, world.x0, world.y0);
  };

  const lookCache = new TileTextureCache({ maxEntries: 64, maxBytes: 96 * 1024 });
  const LOOK_POSE_KEY = ["idle", "walkL", "walkR"] as const;
  let local: NodeMirror | null = null;
  let localName: NodeMirror | null = null;
  let localRec: SpriteRec = { tileRef: null, tileIdx: -1 };
  interface RemoteRec extends SpriteRec {
    node: NodeMirror;
    label: NodeMirror;
    live: boolean;
    worldX: number;
    worldY: number;
  }
  const remotePool: RemoteRec[] = [];
  const remoteUsed = new Map<number, RemoteRec>();
  const villagerPool: VillagerRec[] = [];
  const villagers = new Map<string, VillagerRec>();
  /** Test hook: increments when a remote node is born or recycled (the
   *  steady state must not churn the pool). */
  let nodeChurn = 0;

  const cameraResult = { x: 0, y: 0, tx: 0, ty: 0 };
  const camera = () => {
    const p = client?.predictor?.current;
    const world = ringWorld;
    if (!p || !world) {
      cameraResult.x = 0; cameraResult.y = 0;
      cameraResult.tx = 0; cameraResult.ty = 0;
      return cameraResult;
    }
    // The window's world-px rect (it need not start at 0).
    const left = world.x0 * TILE;
    const top = world.y0 * TILE;
    const wx = left + p.move.px + TILE / 2;
    const wy = top + p.move.py + TILE / 2;
    const x = vp.w >= WORLD_PX ? left + Math.floor((WORLD_PX - vp.w) / 2)
      : Math.min(Math.max(Math.floor(wx - vp.w / 2), left), left + WORLD_PX - vp.w);
    const y = vp.h >= WORLD_PX ? top + Math.floor((WORLD_PX - vp.h) / 2)
      : Math.min(Math.max(Math.floor(wy - vp.h / 2), top), top + WORLD_PX - vp.h);
    cameraResult.x = x; cameraResult.y = y;
    cameraResult.tx = p.move.tx; cameraResult.ty = p.move.ty;
    return cameraResult;
  };

  const setSprite = (node: NodeMirror, look: number, pose: number, facing: number, rec: SpriteRec) => {
    const lk = WANDER_LOOKS[look]!;
    const idx = lk.frames[LOOK_POSE_KEY[pose]!][facing]!;
    const ref = `${lk.tileset}#${idx}`;
    if (ref !== rec.tileRef) {
      if (rec.tileRef !== null) {
        getOps().setImage(node.id, -1);
        lookCache.release(rec.tileRef);
      }
      const handle = lookCache.acquire({ kind: "tile", ref, sourceWidth: TILE, sourceHeight: TILE });
      getOps().setImage(node.id, handle);
      rec.tileRef = ref;
      rec.tileIdx = idx;
    }
  };

  const releaseSprite = (rec: SpriteRec, node: NodeMirror) => {
    if (rec.tileRef !== null) {
      getOps().setImage(node.id, -1);
      lookCache.release(rec.tileRef);
      rec.tileRef = null;
      rec.tileIdx = -1;
    }
  };

  const makeRemote = (spriteParent: NodeMirror, labelParent: NodeMirror): RemoteRec => {
    const node = createElement("image");
    setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: TILE, height: TILE });
    setProp(node, "debugName", "online-remote");
    insertNode(spriteParent, node);
    const label = createElement("text");
    setProp(label, "style", { posType: 1, insetL: 0, insetT: 0, width: 80, height: 12, textColor: "#ffe97a", lineHeight: 12, textAlign: 1 });
    setProp(label, "debugName", "online-remote-name");
    insertNode(labelParent, label);
    return { node, label, tileRef: null, tileIdx: -1, live: false, worldX: 0, worldY: 0 };
  };

  const makeVillager = (parent: NodeMirror): VillagerRec => {
    const node = createElement("image");
    setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: TILE, height: TILE });
    setProp(node, "debugName", "online-villager");
    insertNode(parent, node);
    return { node, x: NaN, y: NaN, live: false, lookId: 0, tileRef: null, tileIdx: -1 };
  };

  const syncWorld = (now: number) => {
    const c = client;
    const world = c?.predictor?.world;
    if (!c || !world) return;
    ensureRing(world);
    const r = ring!;
    const cam = camera();
    const off = r.update(cam.x, cam.y, NO_FRESH_CHUNKS);
    jump(r.root, "translateX", off.x);
    jump(r.root, "translateY", off.y);

    // Local player: centred under the camera, drawn between ground and
    // upper like the single-player view's walkers.
    const p = c.predictor!.current;
    if (!local || !localName) {
      const node = createElement("image");
      setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: TILE, height: TILE });
      setProp(node, "debugName", "online-local");
      insertNode(r.sprites, node);
      const label = createElement("text");
      setProp(label, "style", { posType: 1, insetL: 0, insetT: 0, width: 80, height: 12, textColor: "#ffffff", lineHeight: 12, textAlign: 1 });
      setProp(label, "debugName", "online-local-name");
      insertNode(nameOverlay!, label);
      local = node;
      localName = label;
    }
    const myNode = local;
    const myLabel = localName;
    const myLook = roster.get(c.myId)?.look ?? lookSel();
    setSprite(myNode, myLook, walkPose(p.move.phase), p.move.facing, localRec);
    const lx = Math.round((world.x0 - r.ox) * TILE + p.move.px);
    const ly = Math.round((world.y0 - r.oy) * TILE + p.move.py);
    jump(myNode, "translateX", lx);
    jump(myNode, "translateY", ly);
    getOps().setText(myLabel.id, roster.get(c.myId)?.name ?? login());
    jump(myLabel, "translateX", lx - 32);
    jump(myLabel, "translateY", ly - 14);

    // Frozen-world residents follow the same reducer event state and
    // deterministic W-CHAR look mapping as the single-player wander view.
    const probe = globalThis.__onlineVillagerPositions === undefined ? null : {} as Record<string, {
      look: number;
      pose: number;
      facing: number;
      x: number;
      y: number;
      sx: number;
      sy: number;
    }>;
    const oxScreen = r.ox * TILE - cam.x;
    const oyScreen = r.oy * TILE - cam.y;
    for (const rec of villagers.values()) rec.live = false;
    for (const id in p.chars.chars) {
      const ch = p.chars.chars[id]!;
      if (!ch.visible) continue;
      const parsed = parseVillagerId(id);
      if (!parsed) continue;
      const x = Math.round((world.x0 - r.ox) * TILE + ch.px);
      const y = Math.round((world.y0 - r.oy) * TILE + ch.py);
      const probedLook = probe ? lookId(lookFor(world.seed, parsed.rx, parsed.ry, parsed.n)) : -1;
      if (probe) {
        probe[id] = {
          look: probedLook,
          pose: walkPose(ch.phase),
          facing: ch.facing,
          x: ch.px,
          y: ch.py,
          sx: Math.round(x + oxScreen),
          sy: Math.round(y + oyScreen),
        };
      }
      if (globalThis.__onlineDeferVillagers === true) continue;
      let rec = villagers.get(id);
      if (!rec) {
        rec = villagerPool.pop() ?? makeVillager(r.sprites);
        rec.lookId = probedLook >= 0 ? probedLook : lookId(lookFor(world.seed, parsed.rx, parsed.ry, parsed.n));
        villagers.set(id, rec);
      }
      rec.live = true;
      setSprite(rec.node, rec.lookId, walkPose(ch.phase), ch.facing, rec);
      if (x !== rec.x) { jump(rec.node, "translateX", x); rec.x = x; }
      if (y !== rec.y) { jump(rec.node, "translateY", y); rec.y = y; }
    }
    for (const [id, rec] of villagers) {
      if (rec.live) continue;
      villagers.delete(id);
      releaseSprite(rec, rec.node);
      jump(rec.node, "translateX", -10000);
      villagerPool.push(rec);
    }
    if (probe) globalThis.__onlineVillagerPositions = probe;

    // Remote players: pooled walkers with name labels, interpolated.
    for (const rec of remoteUsed.values()) rec.live = false;
    c.interp.forEach((id) => {
      const pos = c.interp.renderAt(id, now);
      if (!pos) return;
      let rec = remoteUsed.get(id);
      if (!rec) {
        rec = remotePool.pop();
        if (!rec) {
          rec = makeRemote(r.sprites, nameOverlay!);
          nodeChurn++;
        }
        remoteUsed.set(id, rec);
      }
      rec.live = true;
      const entry = roster.get(id);
      setSprite(rec.node, entry?.look ?? 0, walkPose(pos.phase), pos.dir, rec);
      const sx = Math.round((world.x0 - r.ox) * TILE + pos.x);
      const sy = Math.round((world.y0 - r.oy) * TILE + pos.y);
      rec.worldX = pos.x;
      rec.worldY = pos.y;
      jump(rec.node, "translateX", sx);
      jump(rec.node, "translateY", sy);
      getOps().setText(rec.label.id, entry?.name ?? "");
      jump(rec.label, "translateX", sx - 32);
      jump(rec.label, "translateY", sy - 14);
    });
    for (const [id, rec] of remoteUsed) {
      if (rec.live) continue;
      remoteUsed.delete(id);
      releaseSprite(rec, rec.node);
      jump(rec.node, "translateX", -10000);
      jump(rec.label, "translateX", -10000);
      remotePool.push(rec);
      nodeChurn++;
    }
  };

  // -- input + frame -----------------------------------------------------------
  const auto = new AutoWalk(
    () => (globalThis.performance ? globalThis.performance.now() : Date.now()),
    { x: WINDOW / 2, y: WINDOW / 2 },
  );
  let autoHome = false;
  let idle = 0;
  let autoMode = true;
  let prevButtons = 0;
  let prevTouchIds = new Set<number>();
  let hudTimer = 0;
  let logTimer = 0;
  let menuHeld = false;
  const publishedRemote: { id: number; x: number; y: number }[] = [];

  const refreshHud = () => {
    const c = client;
    if (!c) return;
    const h = c.hud();
    const cam = camera();
    const status = h.status === "rejected" && h.rejectText
      ? h.rejectText
      : h.status === "retrying" && h.rejectText
        ? `${h.rejectText} · RETRY ${Math.ceil(h.retryIn / 1000)}s`
        : h.status === "joined"
          ? `ONLINE #${h.myId}`
          : h.status.toUpperCase();
    batch(() => {
      setStatusText(status);
      setNameLine(`${roster.get(c.myId)?.name ?? (login() || "?")} · ROOM ${h.online} · ALL ${h.allOnline}`);
      setDebugText(`RTT ${h.rtt}ms  CORR ${h.corrections}  UNACKED ${h.unacked}`);
      setPosText(`X ${cam.tx}  Y ${cam.ty}  ${autoMode ? "AUTO" : "YOU"}`);
    });
  };

  const edge = (cur: number, btn: number) => (cur & btn) !== 0 && (prevButtons & btn) === 0;

  const publish = () => {
    const c = client;
    const out: OnlinePublished = globalThis.__onlineState ?? ({} as OnlinePublished);
    const h = c?.hud();
    out.status = h?.status ?? "idle";
    out.screen = screen();
    out.myId = h?.myId ?? 0;
    out.online = h?.online ?? 0;
    out.allOnline = h?.allOnline ?? 0;
    out.rtt = h?.rtt ?? 0;
    out.corrections = h?.corrections ?? 0;
    out.unacked = h?.unacked ?? 0;
    out.x = camera().tx;
    out.y = camera().ty;
    out.moving = c?.predictor?.current.move.moving ?? false;
    out.auto = autoMode;
    out.login = login();
    out.createError = createError();
    out.notice = notice();
    out.look = lookSel();
    out.linkCode = codeDisplay();
    out.linkCursor = linkCursor();
    out.villagers = villagers.size;
    out.roster = publishedRoster;
    let remoteCount = 0;
    for (const [id, rec] of remoteUsed) {
      let item = publishedRemote[remoteCount];
      if (!item) {
        item = { id, x: 0, y: 0 };
        publishedRemote[remoteCount] = item;
      }
      item.id = id;
      item.x = Math.round(rec.worldX);
      item.y = Math.round(rec.worldY);
      remoteCount++;
    }
    publishedRemote.length = remoteCount;
    out.remote = publishedRemote;
    globalThis.__onlineState = out;
    globalThis.__onlineNodeChurn = nodeChurn;
    globalThis.__onlineArrayAllocations = c?.interp.idArrayAllocations ?? 0;
  };

  /** Tap handling on the creation screen: tap a charset cell to type, tap
   *  the preview to change the look. */
  const handleCreateTap = (x: number, y: number) => {
    const l = createLayout(vp.w, vp.h);
    const inBox = (b: HudRect) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;
    if (inBox(l.previewPanel)) {
      createFocus = "look";
      setFocusSig("look");
      if (inBox(l.previewBox)) setLookSel(cycleLookBase(lookSel(), 1));
      else if (inBox(l.counterRect)) setLookSel(cycleLookPalette(lookSel(), 1));
      return;
    }
    if (!inBox(l.namePanel)) return;
    createFocus = "name";
    setFocusSig("name");
    const g = createNameGrid(l);
    const col = Math.floor((x - g.x) / g.cellW);
    const row = Math.floor((y - g.y) / g.cellH);
    if (col < 0 || col >= g.cols || row < 0 || row >= ns.rows) return;
    const index = row * g.cols + col;
    if (index >= ns.charset.length + 3) return;
    ns.cursor = index;
    ns = nameInputRules.step(
      ns as never,
      { buttons: 0, upEdge: false, downEdge: false, leftEdge: false, rightEdge: false, confirmEdge: true, cancelEdge: false },
      0,
    ) as unknown as NameInputState;
    setNameState({ ...ns });
    const done = nameInputRules.done(ns as never);
    if (done && !done.cancelled) submitCreate();
  };

  onFrame((buttons) => {
    const now = globalThis.performance ? globalThis.performance.now() : Date.now();

    // Follow the host viewport (fixed 480x272 on PSP, dynamic on desktop/web).
    const nextVp = hostViewport(getOps());
    if (nextVp && (nextVp.w !== vp.w || nextVp.h !== vp.h)) {
      vp = { ...nextVp };
      setViewport(vp);
      setProp(fieldRoot, "style", { width: vp.w, height: vp.h });
      ring?.resize(ringCols(), ringRows());
    }

    if (screen() === "gate") {
      if (!isDesktop) {
        prevButtons = buttons;
        publish();
        return;
      }
      if (edge(buttons, BTN.UP)) applyLinkAction({ type: "move", dx: 0, dy: -1 });
      if (edge(buttons, BTN.RIGHT)) applyLinkAction({ type: "move", dx: 1, dy: 0 });
      if (edge(buttons, BTN.DOWN)) applyLinkAction({ type: "move", dx: 0, dy: 1 });
      if (edge(buttons, BTN.LEFT)) applyLinkAction({ type: "move", dx: -1, dy: 0 });
      if (edge(buttons, BTN.CROSS) || edge(buttons, BTN.SQUARE)) applyLinkAction({ type: "backspace" });
      if (edge(buttons, BTN.CIRCLE)) applyLinkAction({ type: "activate" });
      const ts = touches();
      for (const t of ts) {
        if (prevTouchIds.has(t.id)) continue;
        const g = linkGateRect(vp.w, vp.h);
        for (let i = 0; i < LINK_PAD_KEYS.length; i++) {
          const cell = linkPadCell(g, i);
          if (t.x >= cell.x0 && t.x < cell.x1 && t.y >= cell.y0 && t.y < cell.y1) {
            codeState = { code: codeState.code, cursor: i };
            setLinkCursor(i);
            applyLinkAction({ type: "activate" });
            break;
          }
        }
      }
      prevTouchIds = new Set(ts.map((t) => t.id));
      prevButtons = buttons;
      publish();
      return;
    }

    if (screen() === "creating") {
      // L1/R1 toggles between the name grid and the look preview.
      if (edge(buttons, BTN.LTRIGGER) || edge(buttons, BTN.RTRIGGER)) {
        createFocus = createFocus === "name" ? "look" : "name";
        setFocusSig(createFocus);
      }
      if (createFocus === "look") {
        // LOOK focus: d-pad changes the character, the name cursor rests.
        if (edge(buttons, BTN.LEFT)) setLookSel(cycleLookBase(lookSel(), -1));
        if (edge(buttons, BTN.RIGHT)) setLookSel(cycleLookBase(lookSel(), 1));
        if (edge(buttons, BTN.UP)) setLookSel(cycleLookPalette(lookSel(), 1));
        if (edge(buttons, BTN.DOWN)) setLookSel(cycleLookPalette(lookSel(), -1));
        if (edge(buttons, BTN.CIRCLE) || edge(buttons, BTN.CROSS)) {
          createFocus = "name";
          setFocusSig("name");
        }
        ns = nameInputRules.step(
          ns as never,
          { buttons: 0, upEdge: false, downEdge: false, leftEdge: false, rightEdge: false, confirmEdge: false, cancelEdge: false },
          Math.max(1, Math.round(60 / hz)),
        ) as unknown as NameInputState;
      } else {
        // NAME focus: the name-input rules own the d-pad.
        ns = nameInputRules.step(
          ns as never,
          {
            buttons,
            upEdge: edge(buttons, BTN.UP),
            downEdge: edge(buttons, BTN.DOWN),
            leftEdge: edge(buttons, BTN.LEFT),
            rightEdge: edge(buttons, BTN.RIGHT),
            confirmEdge: edge(buttons, BTN.CIRCLE),
            cancelEdge: edge(buttons, BTN.CROSS),
          },
          Math.max(1, Math.round(60 / hz)),
        ) as unknown as NameInputState;
      }
      setNameState({ ...ns });
      const done = nameInputRules.done(ns as never);
      if (done && !done.cancelled) submitCreate();
      // Touch: tap a charset cell to type, tap the preview to change look.
      const ts = touches();
      for (const t of ts) {
        if (!prevTouchIds.has(t.id)) handleCreateTap(t.x, t.y);
      }
      prevTouchIds = new Set(ts.map((t) => t.id));
      prevButtons = buttons;
      publish();
      return;
    }

    // World.
    const c = client;
    if (!c) {
      prevButtons = buttons;
      return;
    }
    const dpad = buttons & (BTN.UP | BTN.RIGHT | BTN.DOWN | BTN.LEFT);
    if (dpad) {
      if (autoMode) auto.reset();
      autoMode = false;
      idle = 0;
    } else if (!autoMode && ++idle >= IDLE_RESUME_SECONDS * hz) {
      autoMode = true;
    }
    const autoMask = autoMode ? auto.mask(c.predictor?.current.move.tx ?? 0, c.predictor?.current.move.ty ?? 0) : 0;
    if (!autoHome && c.predictor) {
      autoHome = true;
      auto.home = { x: c.predictor.current.move.tx, y: c.predictor.current.move.ty };
    }
    c.onFrame(buttons, hz, autoMask);
    syncWorld(now);
    if (edge(buttons, BTN.TRIANGLE)) setDebugOn(!debugOn());
    if (++hudTimer >= HUD_EVERY) {
      hudTimer = 0;
      refreshHud();
    }
    const menuBtn = (buttons & BTN.SELECT) !== 0;
    if (menuBtn && !menuHeld) setMenuOpen(!menuOpen());
    menuHeld = menuBtn;
    if (menuOpen()) {
      if (edge(buttons, BTN.CROSS)) {
        setMenuOpen(false);
        setDeleteArmed(false);
      }
      if (edge(buttons, BTN.CIRCLE)) {
        const ticket = c.auth.kind === "ticket" ? c.auth.ticket : loadTicket() ?? "";
        c.sendText(JSON.stringify({ type: "linkq", v: AUTH_PROTOCOL_VERSION, ticket }));
        setMenuOpen(false);
        setDeleteArmed(false);
      }
      if (edge(buttons, BTN.SQUARE)) {
        const now = Date.now();
        if (deleteArmed() && now - deleteArmedAt < 5000) {
          setDeleteArmed(false);
          setMenuOpen(false);
          const ticket = c.auth.kind === "ticket" ? c.auth.ticket : loadTicket() ?? "";
          c.sendText(JSON.stringify({ type: "delete", v: AUTH_PROTOCOL_VERSION, ticket }));
          showNotice("Deleting profile…");
        } else {
          deleteArmedAt = now;
          setDeleteArmed(true);
        }
      }
    }
    if (notice() && Date.now() > noticeUntil) setNotice("");
    publish();
    if (++logTimer >= hz) {
      logTimer = 0;
      console.log(`ONLINE ${JSON.stringify(globalThis.__onlineState)}`);
    }
    prevButtons = buttons;
  });
  refreshHud();

  const plate = () => statusPlate(viewport().w, viewport().h, debugOn());
  const gate = () => isDesktop ? linkGateRect(viewport().w, viewport().h) : gateRect(viewport().w, viewport().h);
  const menu = () => menuRect(viewport().w, viewport().h);

  return (
    <View class="w-full h-full overflow-hidden bg-black">
      <Show when={screen() === "world"}>
        <View class="absolute overflow-hidden" style={{ posType: 1, insetL: 0, insetT: 0, width: viewport().w, height: viewport().h }} debugName="online-field">
          {fieldRoot as unknown as ReturnType<typeof View>}
        </View>
        <View class="absolute" style={{ posType: 1, ...rect(plate()), bgColor: "#0b1626", opacity: 0.84 }} debugName="online-plate" />
        <Text class="text-xs" style={{ posType: 1, insetT: plate().y0 + 2, insetL: 12, width: plate().x1 - 18, textColor: "#ffe97a", lineHeight: 12, height: 12 }}>{statusText()}</Text>
        <Text class="text-xs" style={{ posType: 1, insetT: plate().y0 + 15, insetL: 12, width: plate().x1 - 18, textColor: "#9fd0ff", lineHeight: 12, height: 12 }}>{nameLine()}</Text>
        <Show when={debugOn()}>
          <Text class="text-xs" style={{ posType: 1, insetT: plate().y0 + 28, insetL: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{debugText()}</Text>
          <Text class="text-xs" style={{ posType: 1, insetT: plate().y0 + 41, insetL: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{posText()}</Text>
        </Show>
        <View class="absolute" style={{ posType: 1, ...rect(helpRect(viewport().w, viewport().h)), bgColor: "#0b1626", opacity: 0.84 }} debugName="online-help" />
        <Text class="text-xs" style={{ posType: 1, insetT: helpRect(viewport().w, viewport().h).y0 + 2, insetL: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>
          D-PAD MOVE · SEL MENU · TRI DEBUG
        </Text>
        <Show when={notice() !== ""}>
          <View class="absolute flex-row justify-center" style={{ posType: 1, insetT: noticeRect(viewport().w, viewport().h, debugOn()).y0, insetL: 0, insetR: 0 }} debugName="online-notice">
            <View style={{ bgColor: "#0b1626", paddingL: 10, paddingR: 10, paddingT: 2, paddingB: 2 }}>
              <Text class="text-sm" style={{ textColor: "#8ad0ff", lineHeight: 18, height: 18 }}>{notice()}</Text>
            </View>
          </View>
        </Show>
        <Show when={menuOpen()}>
          <View class="absolute" style={{ posType: 1, ...rect(menu()), bgColor: "#0b1626", borderWidth: 1, borderColor: "#3a4a6a" }} debugName="online-menu" />
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 8, insetL: menu().x0 + 10, textColor: "#ffe97a", lineHeight: 14, height: 14 }}>MENU</Text>
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 28, insetL: menu().x0 + 10, textColor: "#c8d6ea", lineHeight: 14, height: 14 }}>CIRCLE: link device</Text>
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 46, insetL: menu().x0 + 10, textColor: deleteArmed() ? "#ffe97a" : "#c8d6ea", lineHeight: 14, height: 14 }}>
            {deleteArmed() ? "SQUARE: confirm delete" : "SQUARE: delete profile"}
          </Text>
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 64, insetL: menu().x0 + 10, textColor: "#c8d6ea", lineHeight: 14, height: 14 }}>CROSS: close</Text>
        </Show>
      </Show>
      <Show when={screen() === "gate"}>
        <View class="absolute" style={{ posType: 1, ...rect(gate()), bgColor: "#0b1626", borderWidth: 1, borderColor: "#3a4a6a" }} debugName="online-gate" />
        <Text class="text-sm" style={{ posType: 1, insetT: gate().y0 + 12, insetL: gate().x0 + 16, width: gate().x1 - gate().x0 - 32, textColor: "#ffe97a", lineHeight: 18, height: 36 }}>{gateText()}</Text>
        <Show when={isDesktop}>
          <Text class="text-xs" style={{ posType: 1, insetT: gate().y0 + 52, insetL: gate().x0 + 16, width: gate().x1 - gate().x0 - 32, textColor: "#c8d6ea", lineHeight: 14, height: 14 }}>
            Code: {codeDisplay() || "______"}
          </Text>
          {LINK_PAD_KEYS.map((key, index) => {
            const cell = () => linkPadCell(gate(), index);
            const label = key === "back" ? "DEL" : key === "submit" ? "OK" : key;
            return (
              <View
                class="absolute items-center justify-center"
                style={{ posType: 1, ...rect(cell()), bgColor: linkCursor() === index ? "#ffe17a" : "#1b2944", borderWidth: 1, borderColor: "#536b9d" }}
                debugName={`online-link-key-${index}`}
              >
                <Text class="text-sm" style={{ textColor: linkCursor() === index ? "#0b1626" : "#e7edf8", lineHeight: 18, height: 18 }}>{label}</Text>
              </View>
            );
          })}
          <Text class="text-xs" style={{ posType: 1, ...rect(linkHintRect(gate())), textColor: "#8d97a8", lineHeight: 14 }}>
            D-PAD select · CIRCLE enter · CROSS delete
          </Text>
        </Show>
      </Show>
      <Show when={screen() === "creating"}>
        <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 0, width: viewport().w, height: viewport().h, bgColor: "#0d0f14" }} debugName="online-creating" />
        <CreateCharScene state={nameState() as never} look={lookSel()} focus={focusSig()} width={viewport().w} height={viewport().h} />
        <Show when={createError()}>
          <Text class="text-xs" style={{ posType: 1, insetB: 8, insetL: 12, textColor: "#ff6b6b", lineHeight: 12, height: 12 }}>{createError()}</Text>
        </Show>
      </Show>
    </View>
  );
}

export type { AuthCredential };
