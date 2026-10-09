// examples/wander-online/OnlineView.tsx — the wander-online world on screen.
//
// Three screens, one account:
//   gate       web: "sign in with GitHub on this page"; desktop: enter a
//              6-digit link code from a signed-in web client. No socket.
//   creating   first sign-in: pick a name (the built-in name-input rules)
//              default = GitHub login) and a look from the 64-entry W-CHAR
//              pool, with a large animated preview.
//   world      the shared realm, drawn with the single-player render ring
//              (real terrain, roads, stamps): the local player is predicted
//              and centred under the camera, remote players walk and show
//              name labels, town residents walk their routes on the realm
//              clock, and the single-player gameplay (talk, notice boards,
//              plaza errands, the travel log and rumors) runs with the
//              server as the authority. A SELECT menu links a device,
//              deletes the profile, and toggles debug and auto-walk.
//
// The net client (net/client.ts) owns the socket, prediction and
// interpolation; this view presents it and drives the auth handshake.
// Every dialog, board, errand and notice string comes from the same pure
// content functions single-player uses (../wander/towns.ts), so the words a
// player reads online are the words the offline game would show.

import { batch, createSignal, Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createElement, insertNode, replaceText, setProp } from "@pocketjs/framework/renderer";
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
import { walkPose } from "../../vendor/pocket-rpgkit/src/engine/movement.ts";
import { TileTextureCache } from "../../vendor/pocket-rpgkit/src/ui/tile-texture-cache.ts";
import { regionName, type RegionPlan } from "../wander/region.ts";
import { regionHub, regionOf } from "../wander/world.ts";
import { nearestLandmark } from "../wander/landmarks.ts";
import { purePlacedLandmark, townErrand, townFacts, townPlaque, townTalk, type TownLookups } from "../wander/towns.ts";
import { NAME_INPUT_ACTION_OK, nameInputRules, type NameInputState } from "../../vendor/pocket-rpgkit/src/engine/name-input.ts";
import { CreateCharScene, type CreateFocus } from "./CreateCharScene.tsx";
import {
  DIALOG_ROWS,
  DIALOG_ROW_H,
  EMOTE_CELLS,
  FAR_LABEL_W,
  FAR_MARKER_SIZE,
  dialogRect,
  emoteBarRect,
  emoteCell,
  errandBarRect,
  farMarkerPoint,
  farMarkerRect,
  gateRect,
  helpRect,
  linkGateRect,
  linkHintRect,
  linkPadCell,
  logBarRect,
  menuRect,
  noticeRect,
  statusPlate,
  type HudRect, NAME_LABEL_W } from "./hud.ts";
import { createLayout, createNameGrid } from "./hud.ts";
import type { ArenaWorld } from "./net/world.ts";
import { RealmWorld, realmRegionKey } from "./net/realm-world.ts";
import { RealmPredictor } from "./net/realm-predict.ts";
import { OnlineClient, type AuthCredential, type SocketFactory } from "./net/client.ts";
import { COMMAND, type RosterEntry } from "./net/protocol.ts";
import { JOURNEY_EVENT, PLAZA_RADIUS, errandHudText, journeyEventText, journeyIsHelped, resolveErrand } from "./net/journey.ts";
import { frontTile, plaqueOf, talkTarget, ticksSinceDiscovery, townResidentsAt, type NpcPose } from "./net/npc.ts";
import { loadTicket, saveTicket, clearTicket, loadRealm, saveRealm, clearRealm } from "./auth-store.ts";
import { EMOTE_TABLE, emoteGlyph } from "./net/emote.ts";
import { FAR_BAND_WORDS, farVector } from "./net/far.ts";
import { INVITE_TTL_SEC, parseInviteToken } from "./shared/invite.ts";
import { AUTH_PROTOCOL_VERSION, NAME_MAX, validateName } from "./shared/auth.ts";
import { nameGridCharset } from "./shared/name-charset.ts";
import { describeCreateError } from "./create-text.ts";
import { LINK_PAD_KEYS, stepLinkCode, type LinkCodeState } from "./link-code.ts";

type OnlineClientOptsSocketFactory = SocketFactory | undefined;

const PSP_W = 480;
const PSP_H = 272;
const WORLD_PX = WINDOW * TILE;
const HUD_EVERY = 6;
const AUTO_DIRS = [BTN.UP, BTN.RIGHT, BTN.DOWN, BTN.LEFT] as const;
const DPAD = BTN.UP | BTN.RIGHT | BTN.DOWN | BTN.LEFT;
const NO_FRESH_CHUNKS: readonly never[] = [];
/** Expanded dialog lines kept per (region, resident, helped), like the
 *  single-player sim's talk-line memo. */
const TALK_CACHE_CAP = 256;
/** Notice durations, the single-player view's frame counts in ms. */
const NOTICE_EVENT_MS = 4000;
const NOTICE_LOG_MS = 4000;
const NOTICE_EMPTY_MS = 2000;
/** Rumor scan radius in regions (the single-player HUD's). */
const RUMOR_RADIUS = 4;

/** What the game reports to the web page's control bar (the page's
 *  player.js installs `__pocketAuthEvent`). `nameInput` opens the page's
 *  text box, which can take an input method for a Chinese name; the page
 *  answers through `__pocketAuthCommand("name", text)`. */
export type PageAuthEvent =
  | { type: "login"; login: string }
  | { type: "logout" }
  | { type: "nameInput"; title: string; maxLength: number; value: string; error: string }
  | { type: "nameInputEnd" }
  /** The player minted a realm invite: show a shareable link built from
   *  the token (`<realm>.<CODE>`), valid for `expiresIn` seconds. */
  | { type: "invite"; token: string; expiresIn: number }
  | { type: "inviteEnd" }
  /** The invite the page handed over (`__pocketInvite`) admitted us: the
   *  page may forget it. */
  | { type: "inviteConsumed" };

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
  /** Demo/test hook: start with the auto-walk driver on (it is opt-in
   *  online; the menu's START toggles it at runtime). */
  // eslint-disable-next-line no-var
  var __onlineAutoWalk: boolean | undefined;
  /** Set by the web player page after the GitHub OAuth redirect: the
   *  one-time GitHub token. The game swaps it for a ticket and the page
   *  never persists it. */
  // eslint-disable-next-line no-var
  var __pocketAuth: { token?: string } | undefined;
  /** Explicitly installed by the browser player before loading assets. */
  // eslint-disable-next-line no-var
  var __pocketWeb: boolean | undefined;
  /** The game installs this so the page can show "Signed in as X" and,
   *  while the creation screen is open, a text box for the name. */
  // eslint-disable-next-line no-var
  var __pocketAuthEvent: ((ev: PageAuthEvent) => void) | undefined;
  /** The page calls this to sign out ("signout"), to submit the name
   *  typed into its text box ("name", text) or to close the invite link
   *  box ("inviteEnd"). */
  // eslint-disable-next-line no-var
  var __pocketAuthCommand: ((cmd: "signout" | "name" | "inviteEnd", value?: string) => void) | undefined;
  /** An invite token (`<realm>.<CODE>`) the web page took from its URL
   *  fragment: the client joins that realm with that code. */
  // eslint-disable-next-line no-var
  var __pocketInvite: string | undefined;
  /** Test/demo hook: the same token for hosts without a page. */
  // eslint-disable-next-line no-var
  var __onlineInvite: string | undefined;
  /** Test/demo hook: a realm pin for hosts without stored state. */
  // eslint-disable-next-line no-var
  var __onlineRealm: string | undefined;
  /** Demo hook: request one invite as soon as the realm admits us (the
   *  token then shows in the published state and the ONLINE log line). */
  // eslint-disable-next-line no-var
  var __onlineAutoInvite: boolean | undefined;
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
  /** Non-empty for v4 ("legacy" for the retained v3 path). */
  realmId: string;
  /** Pinned deterministic generator version; zero on v3. */
  generatorVersion: number;
  landmarkFirstName: string;
  progressCount: number;
  progressKeys: readonly string[];
  improvementLevel: number;
  /** Server lifetime token for v4 reconnect/rebase verification. */
  epoch: number;
  x: number;
  y: number;
  moving: boolean;
  auto: boolean;
  /** Same as `auto`: the auto-walk driver is on (opt-in online). */
  autoWalk: boolean;
  /** Server-confirmed fast mode. */
  fast: boolean;
  helpedCount: number;
  /** The ERRAND bar's line. */
  errand: string;
  /** Private landmark sightings (the travel log's length). */
  logCount: number;
  /** A talk / notice-board dialog is open (movement blocked). */
  dialog: boolean;
  login: string;
  /** The rejection text from the last createError, "" when creation is not
   *  in a rejected state. */
  createError: string;
  /** The connection refusal shown in the HUD (for hosted acceptance). */
  rejectText: string;
  notice: string;
  look: number;
  linkCode: string;
  linkCursor: number;
  villagers: number;
  roster: Record<number, { name: string; look: number }>;
  remote: { id: number; x: number; y: number }[];
  /** Same-realm players outside the AOI: octant and band only. */
  far: { id: number; dir: number; band: number }[];
  /** Live emote bubbles by player id. */
  emotes: Record<number, number>;
  /** The emote picker is open. */
  emoteBar: boolean;
  /** The last invite token this client minted ("" until then). */
  invite: string;
  /** The realm this client asks for on (re)connect ("" = any). */
  realmPin: string;
}

const DEFAULT_URL = "ws://127.0.0.1:8080/ws";

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

/** A private progress key ("rx,ry") -> region pair. */
function parseKey(key: string): [number, number] {
  const comma = key.indexOf(",");
  return [Number(key.slice(0, comma)), Number(key.slice(comma + 1))];
}

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
    __onlineAutoWalk?: boolean;
    __onlineInvite?: string;
    __onlineRealm?: string;
    __onlineAutoInvite?: boolean;
    __pocketAuth?: { token?: string };
    __pocketInvite?: string;
    __pocketWeb?: boolean;
  };
  const url = resolveUrl(g.__onlineUrl);
  // The realm to ask for: an invite token (from the page's URL fragment or
  // a host hook) names the realm and brings the code; otherwise the pin of
  // the last admission, persisted beside the ticket. Nothing: any realm.
  const inviteFrom = parseInviteToken(g.__pocketInvite ?? g.__onlineInvite ?? "");
  let inviteActive = inviteFrom !== null;
  const initialRealm = inviteFrom?.realm ?? g.__onlineRealm ?? loadRealm();

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
  /** The bottom LOG / ERRAND bars (realm only; the legacy window has no
   *  journey). */
  const [realmOn, setRealmOn] = createSignal(false);
  const [logText, setLogText] = createSignal("");
  const [errandText, setErrandText] = createSignal("");
  /** The open talk / notice-board dialog: its visible rows (at most
   *  DIALOG_ROWS) or none. */
  const [dialogRows, setDialogRows] = createSignal<readonly string[]>([]);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  /** The emote picker (R opens it; LEFT/RIGHT pick, CIRCLE sends). */
  const [emoteOpen, setEmoteOpen] = createSignal(false);
  const [emoteSel, setEmoteSel] = createSignal(0);

  let client: OnlineClient | null = null;
  let noticeUntil = 0;
  /** The demo hook's one invite request, sent once the world is ready. */
  let autoInvitePending = false;
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
    clearRealm();
    if (screen() === "creating") pageNameInputEnd();
    try {
      globalThis.__pocketAuthEvent?.({ type: "logout" });
    } catch {
      // no page
    }
    client?.stop();
    client = null;
    roster.clear();
    for (const id in publishedRoster) delete publishedRoster[id];
    setMenuOpen(false);
    setScreen("gate");
    setGateText("Signed out. Sign in again to play.");
  };
  try {
    globalThis.__pocketAuthCommand = (cmd, value) => {
      if (cmd === "signout") signOut();
      else if (cmd === "name") submitPageName(typeof value === "string" ? value : "");
      else if (cmd === "inviteEnd") setNotice("");
    };
  } catch {
    // desktop
  }

  // -- character creation state ---------------------------------------------
  // The grid offers exactly the ASCII characters the shared name rule
  // accepts (shared/name-charset.ts), so nothing typed here is refused for
  // its characters; Chinese names come through the web page's text box.
  const makeNameState = (defaultName: string): NameInputState => {
    const started = nameInputRules.start(
      null,
      { default: defaultName || "player", maxLength: NAME_MAX, title: "Your Name", charset: nameGridCharset() },
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
      realm: initialRealm,
      invite: inviteFrom?.code ?? null,
      onTicket: (ticket) => saveTicket(ticket),
      onRealm: (realmId) => {
        // Admitted: this is the realm to come back to. An invite that got
        // us in has done its job; the page may forget it.
        saveRealm(realmId);
        if (inviteActive) {
          inviteActive = false;
          pageEvent({ type: "inviteConsumed" });
        }
        if (g.__onlineAutoInvite === true) autoInvitePending = true;
      },
      onNeedCreate: (loginName, ticket) => {
        publishLogin(loginName);
        ns = makeNameState(loginName);
        setNameState({ ...ns });
        createFocus = "name";
        setFocusSig("name");
        setScreen("creating");
        pageNameInput();
      },
      onRoster: (entries) => {
        // A ROSTER after the welcome carries only the players it announces,
        // so the published copy mirrors the whole map (every name known this
        // epoch), not the last message: a later join must not hide our own
        // entry from the diagnostics the demo reads.
        for (const e of entries) {
          roster.set(e.id, e);
          if (e.id === client?.myId) publishLogin(e.name);
        }
        for (const id in publishedRoster) delete publishedRoster[id];
        for (const [id, e] of roster) publishedRoster[id] = { name: e.name, look: e.look };
        if (client?.myId) {
          if (screen() === "creating") pageNameInputEnd();
          setScreen("world");
        }
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
          pageNameInputEnd();
          setScreen("world");
          client?.rejoin();
        } else if (msg.type === "createError") {
          // The server refused this name/look (the boundary check; the
          // client ran the same rule first, so this is a blocklist/
          // version skew case): same recovery as a local refusal.
          rejectCreate(msg.reason);
        } else if (msg.type === "linkCode") {
          showNotice(`Link code: ${msg.code} (5 min)`, 30000);
        } else if (msg.type === "invite" && typeof msg.code === "string" && typeof msg.realm === "string") {
          // The token is the shareable thing: the realm name and the code,
          // nothing about this account. The page turns it into a link.
          const token = `${msg.realm}.${msg.code}`;
          const minutes = Math.max(1, Math.round(Number(msg.expiresIn ?? INVITE_TTL_SEC) / 60));
          showNotice(`INVITE ${token} · ${minutes} min`, 30000);
          pageEvent({ type: "invite", token, expiresIn: Number(msg.expiresIn ?? INVITE_TTL_SEC) });
        } else if (msg.type === "inviteError") {
          showNotice(msg.reason === "invite-rate" ? "Invite: wait a minute" : "Invite unavailable");
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

  /** Tell the web page's control bar that the creation screen is open (it
   *  shows a text box that can take an input method, prefilled with the
   *  grid buffer) or that a submitted name was refused and why. No page
   *  on desktop: the hook is simply absent. */
  const pageNameInput = (error = "") => {
    try {
      globalThis.__pocketAuthEvent?.({ type: "nameInput", title: "Your Name", maxLength: NAME_MAX, value: ns.buffer, error });
    } catch {
      // no page
    }
  };
  const pageNameInputEnd = () => {
    try {
      globalThis.__pocketAuthEvent?.({ type: "nameInputEnd" });
    } catch {
      // no page
    }
  };
  /** Any other page event (invites); no page on desktop. */
  const pageEvent = (ev: PageAuthEvent) => {
    try {
      globalThis.__pocketAuthEvent?.(ev);
    } catch {
      // no page
    }
  };

  /** A name was refused, by the shared rule here or by the server: release
   *  the submit lock and re-arm the name-input scene (OK left it in its
   *  "done" phase, which would auto-resubmit every frame) so the player
   *  can fix the name and try again. The entered buffer and chosen look
   *  are kept; the reason shows in the footer and in the page's box. */
  const rejectCreate = (reason: unknown) => {
    creating = false;
    ns = makeNameState(ns.buffer);
    setNameState({ ...ns });
    const text = describeCreateError(reason);
    setCreateError(text);
    pageNameInput(text);
  };

  /** Submit the scene's committed name. The shared `validateName` (the
   *  rule the server enforces) runs first: a refused name never leaves
   *  the client, and the reason shows at once. */
  const submitCreate = () => {
    if (creating || !client) return;
    const c = client;
    const done = nameInputRules.done(ns as never);
    if (!done || done.cancelled) return;
    const name = ((done as { playerName?: string }).playerName ?? "").trim();
    const refused = validateName(name);
    if (refused) {
      rejectCreate(refused);
      return;
    }
    creating = true;
    setCreateError("");
    const ticket = c.auth.kind === "ticket" ? c.auth.ticket : loadTicket() ?? "";
    c.sendText(JSON.stringify({ type: "create", v: 3, ticket, name, look: lookSel() }));
  };

  /** A name typed into the web page's text box: it replaces the grid
   *  buffer as typed and goes through the same OK path and the same
   *  validation as the grid, so the page cannot bypass anything the grid
   *  enforces (an over-long name is refused, not cut). */
  const submitPageName = (text: string) => {
    if (screen() !== "creating" || creating) return;
    const name = text.trim();
    ns = makeNameState(name);
    ns.buffer = name;
    if (name.length === 0) {
      rejectCreate("name-empty");
      return;
    }
    ns.cursor = ns.charset.length + NAME_INPUT_ACTION_OK;
    ns = nameInputRules.step(
      ns as never,
      { buttons: 0, upEdge: false, downEdge: false, leftEdge: false, rightEdge: false, confirmEdge: true, cancelEdge: false },
      0,
    ) as unknown as NameInputState;
    setNameState({ ...ns });
    const done = nameInputRules.done(ns as never);
    if (done && !done.cancelled) submitCreate();
  };

  // -- world rendering ----------------------------------------------------------
  const fieldRoot = createElement("view");
  setProp(fieldRoot, "style", { posType: 1, insetL: 0, insetT: 0, width: vp.w, height: vp.h });
  setProp(fieldRoot, "debugName", "online-field");

  let ring: RenderRing | null = null;
  type OnlineWorld = ArenaWorld | RealmWorld;
  let ringWorld: OnlineWorld | null = null;
  /** Labels live above the ring's ground, sprites, residents and upper
   *  terrain layers. Keeping them out of `sprites` also prevents a later
   *  player sprite from covering an earlier player's name. */
  let nameOverlay: NodeMirror | null = null;
  const ringCols = () => Math.ceil(vp.w / TILE) + OVERSCAN_LEAD + OVERSCAN_TRAIL + 1;
  const ringRows = () => Math.ceil(vp.h / TILE) + OVERSCAN_LEAD + OVERSCAN_TRAIL + 1;
  const ensureRing = (world: OnlineWorld, tx: number, ty: number) => {
    if (ring && ringWorld === world) return;
    ringWorld = world;
    const source = world instanceof RealmWorld ? world : world.res;
    const originX = world instanceof RealmWorld ? tx : world.x0;
    const originY = world instanceof RealmWorld ? ty : world.y0;
    if (!ring) {
      ring = new RenderRing(
        fieldRoot,
        source,
        world.seed,
        () => ringWorld instanceof RealmWorld ? client?.estimatedServerTime() ?? 0 : ringWorld?.bootNow ?? 0,
      );
      ring.resize(ringCols(), ringRows());
      nameOverlay = createElement("view");
      setProp(nameOverlay, "style", { posType: 1, insetL: 0, insetT: 0, width: 0, height: 0 });
      setProp(nameOverlay, "debugName", "online-name-overlay");
      // RenderRing constructs `upper` last. Appending this container to the
      // ring root therefore makes every name the final world-space layer.
      insertNode(ring.root, nameOverlay);
    }
    ring.reset(source, world.seed, originX, originY);
  };

  const lookCache = new TileTextureCache({ maxEntries: 64, maxBytes: 96 * 1024 });
  const LOOK_POSE_KEY = ["idle", "walkL", "walkR"] as const;
  let local: NodeMirror | null = null;
  let localName: NodeMirror | null = null;
  let localBubble: Bubble | null = null;
  let localRec: SpriteRec = { tileRef: null, tileIdx: -1 };
  /** An emote bubble: a small plate with the preset's glyph, above the
   *  name tag; parked off-screen when the player has no live emote. */
  interface Bubble {
    box: NodeMirror;
    text: NodeMirror;
    shown: number;
  }
  interface RemoteRec extends SpriteRec {
    node: NodeMirror;
    label: NodeMirror;
    bubble: Bubble;
    live: boolean;
    worldX: number;
    worldY: number;
  }
  /** A far player's edge marker: a square at the screen edge in the
   *  octant's direction and a label (name and band word) beside it. */
  interface FarRec {
    box: NodeMirror;
    label: NodeMirror;
    text: string;
    live: boolean;
  }
  const farPool: FarRec[] = [];
  const farUsed = new Map<number, FarRec>();
  /** Screen-space layer for far markers: inside the field, inserted after
   *  the ring root so it draws above the camera-translated world, and below
   *  the HUD plates (JSX siblings after the field). */
  let farOverlay: NodeMirror | null = null;
  const ensureFarOverlay = (): NodeMirror => {
    if (farOverlay) return farOverlay;
    farOverlay = createElement("view");
    setProp(farOverlay, "style", { posType: 1, insetL: 0, insetT: 0, width: 0, height: 0 });
    setProp(farOverlay, "debugName", "online-far-overlay");
    insertNode(fieldRoot, farOverlay);
    return farOverlay;
  };
  const BUBBLE_W = 30;
  const BUBBLE_H = 14;
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
    if (world instanceof RealmWorld) {
      cameraResult.x = Math.floor(p.move.px + TILE / 2 - vp.w / 2);
      cameraResult.y = Math.floor(p.move.py + TILE / 2 - vp.h / 2);
      cameraResult.tx = p.move.tx; cameraResult.ty = p.move.ty;
      return cameraResult;
    }
    // The legacy window's world-px rect (it need not start at 0).
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

  const makeBubble = (parent: NodeMirror, name: string): Bubble => {
    const box = createElement("view");
    setProp(box, "style", { posType: 1, insetL: 0, insetT: 0, width: BUBBLE_W, height: BUBBLE_H, bgColor: "#fff6c4", borderWidth: 1, borderColor: "#6b5a1e" });
    setProp(box, "debugName", name);
    insertNode(parent, box);
    const text = createElement("text");
    setProp(text, "style", { posType: 1, insetL: 0, insetT: 1, width: BUBBLE_W, height: 12, textColor: "#2a2000", lineHeight: 12, textAlign: 1 });
    setProp(text, "debugName", `${name}-text`);
    insertNode(box, text);
    jump(box, "translateX", -10000);
    return { box, text, shown: 0 };
  };

  /** Show the glyph of `emote` above a walker whose sprite sits at (x, y)
   *  in ring space, or park the bubble when there is none. */
  const placeBubble = (b: Bubble, emote: number, x: number, y: number) => {
    if (emote === 0) {
      if (b.shown !== 0) {
        b.shown = 0;
        replaceText(b.text, "");
        jump(b.box, "translateX", -10000);
      }
      return;
    }
    if (b.shown !== emote) {
      b.shown = emote;
      replaceText(b.text, emoteGlyph(emote));
    }
    jump(b.box, "translateX", x + TILE / 2 - BUBBLE_W / 2);
    jump(b.box, "translateY", y - 14 - BUBBLE_H - 2);
  };

  const makeRemote = (spriteParent: NodeMirror, labelParent: NodeMirror): RemoteRec => {
    const node = createElement("image");
    setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: TILE, height: TILE });
    setProp(node, "debugName", "online-remote");
    insertNode(spriteParent, node);
    const label = createElement("text");
    setProp(label, "style", { posType: 1, insetL: 0, insetT: 0, width: NAME_LABEL_W, height: 12, textColor: "#ffe97a", lineHeight: 12, textAlign: 1 });
    setProp(label, "debugName", "online-remote-name");
    insertNode(labelParent, label);
    const bubble = makeBubble(labelParent, "online-remote-emote");
    return { node, label, bubble, tileRef: null, tileIdx: -1, live: false, worldX: 0, worldY: 0 };
  };

  const makeFar = (): FarRec => {
    const box = createElement("view");
    setProp(box, "style", { posType: 1, insetL: 0, insetT: 0, width: FAR_MARKER_SIZE, height: FAR_MARKER_SIZE, bgColor: "#ffe97a", borderWidth: 1, borderColor: "#0b1626" });
    setProp(box, "debugName", "online-far-marker");
    const overlay = ensureFarOverlay();
    insertNode(overlay, box);
    const label = createElement("text");
    setProp(label, "style", { posType: 1, insetL: 0, insetT: 0, width: FAR_LABEL_W, height: 12, textColor: "#ffe97a", lineHeight: 12, textAlign: 0 });
    setProp(label, "debugName", "online-far-name");
    insertNode(overlay, label);
    return { box, label, text: "", live: false };
  };

  /** Far markers: one per same-realm player outside the AOI, at the screen
   *  edge in its octant, labelled with the name and the band word. A player
   *  the snapshot carries exactly is never drawn here as well. */
  const syncFar = (c: OnlineClient) => {
    for (const rec of farUsed.values()) rec.live = false;
    const debug = debugOn();
    const box = farMarkerRect(vp.w, vp.h, debug);
    for (const [id, marker] of c.far) {
      if (remoteUsed.has(id)) continue;
      let rec = farUsed.get(id);
      if (!rec) {
        rec = farPool.pop() ?? makeFar();
        farUsed.set(id, rec);
      }
      rec.live = true;
      const u = farVector(marker.dir);
      const at = farMarkerPoint(vp.w, vp.h, debug, u.x, u.y);
      const mx = Math.min(box.x1 - FAR_MARKER_SIZE, Math.max(box.x0, at.x - FAR_MARKER_SIZE / 2));
      const my = Math.min(box.y1 - FAR_MARKER_SIZE, Math.max(box.y0, at.y - FAR_MARKER_SIZE / 2));
      jump(rec.box, "translateX", mx);
      jump(rec.box, "translateY", my);
      const name = roster.get(id)?.name ?? "?";
      const text = `${name} · ${FAR_BAND_WORDS[marker.band] ?? ""}`;
      if (rec.text !== text) {
        rec.text = text;
        replaceText(rec.label, text);
      }
      // The label sits on the inner side of the marker and stays in the box.
      const onRight = at.x > (box.x0 + box.x1) / 2;
      setProp(rec.label, "style", { textAlign: onRight ? 2 : 0 });
      const lx = onRight ? mx - 4 - FAR_LABEL_W : mx + FAR_MARKER_SIZE + 4;
      const ly = Math.min(box.y1 - 12, Math.max(box.y0, my - 2));
      jump(rec.label, "translateX", lx);
      jump(rec.label, "translateY", ly);
    }
    for (const [id, rec] of farUsed) {
      if (rec.live) continue;
      farUsed.delete(id);
      rec.text = "";
      replaceText(rec.label, "");
      jump(rec.box, "translateX", -10000);
      jump(rec.label, "translateX", -10000);
      farPool.push(rec);
    }
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
    const p = c.predictor!.current;
    ensureRing(world, p.move.tx, p.move.ty);
    const r = ring!;
    const cam = camera();
    const fresh = world instanceof RealmWorld ? world.drainFresh() : NO_FRESH_CHUNKS;
    const off = r.update(cam.x, cam.y, fresh);
    jump(r.root, "translateX", off.x);
    jump(r.root, "translateY", off.y);

    // Local player: centred under the camera, drawn between ground and
    // upper like the single-player view's walkers.
    if (!local || !localName) {
      const node = createElement("image");
      setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: TILE, height: TILE });
      setProp(node, "debugName", "online-local");
      insertNode(r.sprites, node);
      const label = createElement("text");
      setProp(label, "style", { posType: 1, insetL: 0, insetT: 0, width: NAME_LABEL_W, height: 12, textColor: "#ffffff", lineHeight: 12, textAlign: 1 });
      setProp(label, "debugName", "online-local-name");
      insertNode(nameOverlay!, label);
      local = node;
      localName = label;
      localBubble = makeBubble(nameOverlay!, "online-local-emote");
    }
    c.expireEmotes(now);
    const myNode = local;
    const myLabel = localName;
    const myLook = roster.get(c.myId)?.look ?? lookSel();
    setSprite(myNode, myLook, walkPose(p.move.phase), p.move.facing, localRec);
    const worldX0 = world instanceof RealmWorld ? 0 : world.x0;
    const worldY0 = world instanceof RealmWorld ? 0 : world.y0;
    const lx = Math.round((worldX0 - r.ox) * TILE + p.move.px);
    const ly = Math.round((worldY0 - r.oy) * TILE + p.move.py);
    jump(myNode, "translateX", lx);
    jump(myNode, "translateY", ly);
    getOps().setText(myLabel.id, roster.get(c.myId)?.name ?? login());
    jump(myLabel, "translateX", lx + TILE / 2 - NAME_LABEL_W / 2);
    jump(myLabel, "translateY", ly - 14);
    placeBubble(localBubble!, c.emotes.get(c.myId)?.emote ?? 0, lx, ly);

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
    const placeVillager = (id: string, rx: number, ry: number, n: number, px: number, py: number, phase: number, facing: number) => {
      const x = Math.round((worldX0 - r.ox) * TILE + px);
      const y = Math.round((worldY0 - r.oy) * TILE + py);
      const probedLook = probe ? lookId(lookFor(world.seed, rx, ry, n)) : -1;
      if (probe) {
        probe[id] = {
          look: probedLook,
          pose: walkPose(phase),
          facing,
          x: px,
          y: py,
          sx: Math.round(x + oxScreen),
          sy: Math.round(y + oyScreen),
        };
      }
      if (globalThis.__onlineDeferVillagers === true) return;
      let rec = villagers.get(id);
      if (!rec) {
        rec = villagerPool.pop() ?? makeVillager(r.sprites);
        rec.lookId = probedLook >= 0 ? probedLook : lookId(lookFor(world.seed, rx, ry, n));
        villagers.set(id, rec);
      }
      rec.live = true;
      setSprite(rec.node, rec.lookId, walkPose(phase), facing, rec);
      if (x !== rec.x) { jump(rec.node, "translateX", x); rec.x = x; }
      if (y !== rec.y) { jump(rec.node, "translateY", y); rec.y = y; }
    };
    if (world instanceof RealmWorld) {
      // Realm residents: a pure function of (plan, discovery time, realm
      // clock), the same the server evaluates when it validates a talk.
      collectResidents(c, world, p.move.tx, p.move.ty);
      for (const pose of residents) placeVillager(pose.id, pose.rx, pose.ry, pose.n, pose.px, pose.py, pose.phase, pose.facing);
    } else {
      // Frozen-window residents follow the reducer's event state.
      for (const id in p.chars.chars) {
        const ch = p.chars.chars[id]!;
        if (!ch.visible) continue;
        const parsed = parseVillagerId(id);
        if (!parsed) continue;
        placeVillager(id, parsed.rx, parsed.ry, parsed.n, ch.px, ch.py, ch.phase, ch.facing);
      }
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
      const sx = Math.round((worldX0 - r.ox) * TILE + pos.x);
      const sy = Math.round((worldY0 - r.oy) * TILE + pos.y);
      rec.worldX = pos.x;
      rec.worldY = pos.y;
      jump(rec.node, "translateX", sx);
      jump(rec.node, "translateY", sy);
      getOps().setText(rec.label.id, entry?.name ?? "");
      jump(rec.label, "translateX", sx + TILE / 2 - NAME_LABEL_W / 2);
      jump(rec.label, "translateY", sy - 14);
      placeBubble(rec.bubble, c.emotes.get(id)?.emote ?? 0, sx, sy);
    });
    for (const [id, rec] of remoteUsed) {
      if (rec.live) continue;
      remoteUsed.delete(id);
      releaseSprite(rec, rec.node);
      jump(rec.node, "translateX", -10000);
      jump(rec.label, "translateX", -10000);
      placeBubble(rec.bubble, 0, 0, 0);
      remotePool.push(rec);
      nodeChurn++;
    }
    syncFar(c);
  };

  // -- realm gameplay: residents, talk, boards, plaza, log ---------------------
  /** Born residents of the 3x3 regions around the player, rebuilt every
   *  frame from the realm clock (talk targets and sprites). */
  const residents: NpcPose[] = [];
  const collectResidents = (c: OnlineClient, world: RealmWorld, tx: number, ty: number) => {
    residents.length = 0;
    const now = c.estimatedServerTime();
    const prx = regionOf(tx), pry = regionOf(ty);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const rx = prx + dx, ry = pry + dy;
        const row = world.regionState(rx, ry);
        if (!row) continue;
        const plan = world.plans.get(realmRegionKey(rx, ry));
        if (!plan) continue;
        for (const pose of townResidentsAt(plan, ticksSinceDiscovery(row.discoveredAtMs, now))) residents.push(pose);
      }
    }
  };

  /** Pure lookups behind the town facts: identical to the single-player
   *  sim's token resolver (the point hub function and the exact pure
   *  landmark placement). */
  let lookups: TownLookups | null = null;
  let lookupsSeed = NaN;
  const lookupsFor = (seed: number): TownLookups => {
    if (!lookups || lookupsSeed !== seed) {
      lookupsSeed = seed;
      lookups = {
        hubOf: (rx, ry) => regionHub(seed, rx, ry),
        landmarkOf: (rx, ry) => purePlacedLandmark(seed, rx, ry),
      };
    }
    return lookups;
  };
  const talkCache = new Map<string, string[]>();
  /** The dialog lines for a resident (by house, exactly what single-player
   *  passes) or the notice board (house null), memoized per
   *  (region, house, helped). */
  const townLines = (c: OnlineClient, seed: number, plan: RegionPlan, house: number | null): string[] => {
    const helped = journeyIsHelped(seed, c.journey, plan.rx, plan.ry);
    const key = `${house === null ? "p" : "v"}:${plan.rx}:${plan.ry}:${house === null ? "" : `${house}:`}${helped ? 1 : 0}`;
    let lines = talkCache.get(key);
    if (!lines) {
      const facts = townFacts(seed, plan, lookupsFor(seed));
      const errand = townErrand(seed, plan.rx, plan.ry);
      lines = house === null
        ? townPlaque(seed, plan, facts, errand, helped)
        : townTalk(seed, plan, house, facts, errand, helped).lines;
      if (talkCache.size >= TALK_CACHE_CAP) talkCache.clear();
      talkCache.set(key, lines);
    }
    return lines;
  };

  let dialogLines: readonly string[] = [];
  let dialogPage = 0;
  const openDialog = (lines: readonly string[]) => {
    dialogLines = lines;
    dialogPage = 0;
    setDialogRows(lines.slice(0, DIALOG_ROWS));
    setDialogOpen(true);
  };
  const advanceDialog = () => {
    dialogPage += DIALOG_ROWS;
    if (dialogPage >= dialogLines.length) {
      dialogLines = [];
      dialogPage = 0;
      setDialogRows([]);
      setDialogOpen(false);
      return;
    }
    setDialogRows(dialogLines.slice(dialogPage, dialogPage + DIALOG_ROWS));
  };

  /** CIRCLE: talk to the resident in front (the server records the
   *  conversation), or read the notice board in front once it is born. */
  const pressTalk = (c: OnlineClient) => {
    const predictor = c.predictor;
    if (!(predictor instanceof RealmPredictor)) return;
    const world = predictor.world;
    const move = predictor.current.move;
    const target = talkTarget(move, residents);
    if (target) {
      const plan = world.plans.get(realmRegionKey(target.rx, target.ry));
      if (!plan) return;
      openDialog(townLines(c, world.seed, plan, target.house));
      c.sendCommand({ kind: COMMAND.talk, rx: target.rx, ry: target.ry, extra: target.n });
      return;
    }
    const front = frontTile(move);
    const rx = regionOf(front.x), ry = regionOf(front.y);
    const plan = world.plans.get(realmRegionKey(rx, ry));
    if (!plan) return;
    const board = plaqueOf(plan);
    if (!board || board.x !== front.x || board.y !== front.y) return;
    if (world.regionTick(rx, ry, c.estimatedServerTime()) < board.born) return;
    openDialog(townLines(c, world.seed, plan, null));
  };

  /** CROSS outside dialogs: the plaza action near a town hub (accept the
   *  town's offer, or deliver the errand it targets), else page the travel
   *  log like the single-player field. */
  let journalIdx = 0;
  const pageLog = (c: OnlineClient, seed: number) => {
    const keys = c.progressKeys;
    if (keys.length === 0) {
      showNotice("LOG: nothing found yet", NOTICE_EMPTY_MS);
      return;
    }
    journalIdx %= keys.length;
    const [rx, ry] = parseKey(keys[journalIdx]!);
    const kind = purePlacedLandmark(seed, rx, ry)?.kindName ?? "?";
    showNotice(`LOG ${journalIdx + 1}/${keys.length}: ${kind} @ ${regionName(seed, rx, ry)}`, NOTICE_LOG_MS);
    journalIdx++;
  };
  const pressAction = (c: OnlineClient) => {
    const predictor = c.predictor;
    const seed = predictor?.world.seed ?? 0;
    if (!(predictor instanceof RealmPredictor)) {
      pageLog(c, seed);
      return;
    }
    const move = predictor.current.move;
    const rx = regionOf(move.tx), ry = regionOf(move.ty);
    const plan = predictor.world.plans.get(realmRegionKey(rx, ry));
    const nearPlaza = plan !== undefined && plan.hub.town
      && Math.abs(move.tx - plan.hub.x) + Math.abs(move.ty - plan.hub.y) <= PLAZA_RADIUS;
    if (!nearPlaza) {
      pageLog(c, seed);
      return;
    }
    const errand = resolveErrand(seed, c.journey);
    if (!errand) {
      if (townErrand(seed, rx, ry)) c.sendCommand({ kind: COMMAND.acceptErrand, rx, ry, extra: 0 });
    } else if (errand.kind === "deliver" && errand.trx === rx && errand.try === ry) {
      c.sendCommand({ kind: COMMAND.deliverErrand, rx, ry, extra: 0 });
    }
  };

  /** Notices from the server's confirmations: journey events (accepted,
   *  delivered, visited) and new private landmark sightings. The first
   *  PLAYER_PROGRESS of a socket is the stored set, announced to nobody. */
  let lastEventSeq = 0;
  const knownProgress = new Set<string>();
  let progressBaselined = false;
  const pollJourney = (c: OnlineClient, seed: number) => {
    const ev = c.journeyEvent;
    if (ev.seq < lastEventSeq) lastEventSeq = 0;
    if (ev.seq !== lastEventSeq) {
      lastEventSeq = ev.seq;
      if (ev.kind !== JOURNEY_EVENT.talked) {
        const text = journeyEventText(seed, ev);
        if (text) showNotice(text, NOTICE_EVENT_MS);
      }
    }
    if (c.progressMessages === 0) {
      progressBaselined = false;
      return;
    }
    const keys = c.progressKeys;
    if (!progressBaselined) {
      progressBaselined = true;
      knownProgress.clear();
      for (const key of keys) knownProgress.add(key);
      return;
    }
    if (keys.length === knownProgress.size) return;
    for (const key of keys) {
      if (knownProgress.has(key)) continue;
      knownProgress.add(key);
      const [rx, ry] = parseKey(key);
      const lm = purePlacedLandmark(seed, rx, ry);
      if (lm) showNotice(`FOUND: ${lm.kindName}`, NOTICE_EVENT_MS);
    }
  };

  /** Nearest unfound landmark within RUMOR_RADIUS regions, cached per
   *  player tile and progress revision like the single-player sim. */
  let rumorCache: { x: number; y: number; rev: number; count: number; value: { kind: string; dir: string; dist: number } | null } | null = null;
  const nearestRumor = (c: OnlineClient, seed: number, x: number, y: number) => {
    const rev = c.progressRevision, count = c.progressCount;
    if (rumorCache && rumorCache.x === x && rumorCache.y === y && rumorCache.rev === rev && rumorCache.count === count) return rumorCache.value;
    const lm = nearestLandmark(x, y, RUMOR_RADIUS, (rx, ry) => purePlacedLandmark(seed, rx, ry), (rx, ry) => c.progressLandmarks.has(`${rx},${ry}`));
    let value: { kind: string; dir: string; dist: number } | null = null;
    if (lm) {
      const dist = Math.abs(x - lm.cx) + Math.abs(y - lm.cy);
      const wx = Math.sign(lm.cx - x), wy = Math.sign(lm.cy - y);
      const dir = wy < 0 ? (wx < 0 ? "NW" : wx > 0 ? "NE" : "N") : wy > 0 ? (wx < 0 ? "SW" : wx > 0 ? "SE" : "S") : wx < 0 ? "W" : "E";
      value = { kind: lm.kindName, dir, dist };
    }
    rumorCache = { x, y, rev, count, value };
    return value;
  };

  // -- input + frame -----------------------------------------------------------
  const auto = new AutoWalk(
    () => (globalThis.performance ? globalThis.performance.now() : Date.now()),
    { x: WINDOW / 2, y: WINDOW / 2 },
  );
  let autoHome = false;
  /** Auto-walk is opt-in online: the boot hook or the menu's START. A
   *  d-pad press always hands control back to the player and nothing
   *  resumes the driver on its own. */
  let autoMode = g.__onlineAutoWalk === true;
  /** The menu's auto-walk line mirrors `autoMode`. */
  const [menuAuto, setMenuAuto] = createSignal(autoMode);
  let prevButtons = 0;
  let prevTouchIds = new Set<number>();
  let hudTimer = 0;
  let logTimer = 0;
  let menuHeld = false;
  const publishedRemote: { id: number; x: number; y: number }[] = [];
  const publishedFar: { id: number; dir: number; band: number }[] = [];
  const publishedEmotes: Record<number, number> = {};

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
    const realm = c.predictor instanceof RealmPredictor;
    const seed = c.predictor?.world.seed ?? 0;
    const mode = h.fast ? "FAST" : autoMode ? "AUTO" : "YOU";
    batch(() => {
      setStatusText(status);
      setNameLine(`${roster.get(c.myId)?.name ?? (login() || "?")} · ROOM ${h.online} · ALL ${h.allOnline}`);
      setDebugText(`RTT ${h.rtt}ms  CORR ${h.corrections}  FOUND ${h.progressCount}  FIRST ${h.landmarkFirstName || "-"}`);
      setPosText(`X ${cam.tx}  Y ${cam.ty}  ${mode}${h.landmarkFirstName ? `  FIRST ${h.landmarkFirstName}` : ""}`);
      setRealmOn(realm);
      setMenuAuto(autoMode);
      if (realm) {
        // Travel log: private sightings (never decrease) and the nearest rumor.
        const keys = h.progressKeys;
        const latest = keys.length ? keys[keys.length - 1]! : null;
        let latestKind = "—";
        if (latest) {
          const [rx, ry] = parseKey(latest);
          latestKind = purePlacedLandmark(seed, rx, ry)?.kindName ?? "—";
        }
        const rumor = nearestRumor(c, seed, cam.tx, cam.ty);
        setLogText(`LOG ${keys.length} · ${latestKind}    ${rumor ? `RUMOR: ${rumor.kind} ${rumor.dir} ${rumor.dist}` : "RUMOR: nothing nearby"}`);
        setErrandText(errandHudText(resolveErrand(seed, c.journey), c.journey.helpedCount));
      }
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
    out.realmId = h?.realmId ?? "";
    out.generatorVersion = h?.generatorVersion ?? 0;
    out.landmarkFirstName = h?.landmarkFirstName ?? "";
    out.progressCount = h?.progressCount ?? 0;
    out.progressKeys = h?.progressKeys ?? [];
    out.improvementLevel = h?.improvementLevel ?? 0;
    out.epoch = c?.epoch ?? 0;
    out.x = camera().tx;
    out.y = camera().ty;
    out.moving = c?.predictor?.current.move.moving ?? false;
    out.auto = autoMode;
    out.autoWalk = autoMode;
    out.fast = h?.fast ?? false;
    out.helpedCount = h?.helpedCount ?? 0;
    out.errand = errandText();
    out.logCount = h?.progressCount ?? 0;
    out.dialog = dialogOpen();
    out.login = login();
    out.createError = createError();
    out.rejectText = h?.rejectText ?? "";
    out.notice = notice();
    out.look = lookSel();
    out.linkCode = codeDisplay();
    out.linkCursor = linkCursor();
    out.villagers = villagers.size;
    out.roster = publishedRoster;
    let farCount = 0;
    for (const [id, marker] of c?.far ?? []) {
      let item = publishedFar[farCount];
      if (!item) {
        item = { id, dir: 0, band: 0 };
        publishedFar[farCount] = item;
      }
      item.id = id;
      item.dir = marker.dir;
      item.band = marker.band;
      farCount++;
    }
    publishedFar.length = farCount;
    out.far = publishedFar;
    for (const id in publishedEmotes) delete publishedEmotes[id];
    for (const [id, bubble] of c?.emotes ?? []) publishedEmotes[id] = bubble.emote;
    out.emotes = publishedEmotes;
    out.emoteBar = emoteOpen();
    out.invite = c?.inviteToken ?? "";
    out.realmPin = c?.realmPin ?? "";
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
    // A dialog owns the frame: no movement (zero buttons reach the
    // client, so the lockstep stream carries only the fast bit), no
    // auto-walk, and CIRCLE pages it.
    // The emote picker owns the d-pad like a dialog does.
    const dialog = dialogOpen() || emoteOpen();
    const dpad = buttons & DPAD;
    if (dpad && !dialog) {
      if (autoMode) auto.reset();
      autoMode = false;
    }
    const autoMask = autoMode && !dialog ? auto.mask(c.predictor?.current.move.tx ?? 0, c.predictor?.current.move.ty ?? 0) : 0;
    if (!autoHome && c.predictor) {
      autoHome = true;
      auto.home = { x: c.predictor.current.move.tx, y: c.predictor.current.move.ty };
    }
    c.onFrame(dialog ? 0 : buttons, hz, autoMask);
    if (autoInvitePending && c.requestInvite()) autoInvitePending = false;
    syncWorld(now);
    const seed = c.predictor?.world.seed ?? 0;
    pollJourney(c, seed);
    if (++hudTimer >= HUD_EVERY) {
      hudTimer = 0;
      refreshHud();
    }
    const menuBtn = (buttons & BTN.SELECT) !== 0;
    if (menuBtn && !menuHeld && !dialog) setMenuOpen(!menuOpen());
    menuHeld = menuBtn;
    if (menuOpen()) {
      if (edge(buttons, BTN.CROSS)) {
        setMenuOpen(false);
        setDeleteArmed(false);
      }
      if (edge(buttons, BTN.TRIANGLE)) setDebugOn(!debugOn());
      if (edge(buttons, BTN.START)) {
        autoMode = !autoMode;
        if (autoMode) auto.reset();
        setMenuAuto(autoMode);
      }
      if (edge(buttons, BTN.CIRCLE)) {
        const ticket = c.auth.kind === "ticket" ? c.auth.ticket : loadTicket() ?? "";
        c.sendText(JSON.stringify({ type: "linkq", v: AUTH_PROTOCOL_VERSION, ticket }));
        setMenuOpen(false);
        setDeleteArmed(false);
      }
      if (edge(buttons, BTN.LTRIGGER)) {
        // An invite to this realm: the server answers with the token; the
        // notice shows it and the web page offers it as a link.
        if (!c.requestInvite()) showNotice("Invite: not in a world yet");
        setMenuOpen(false);
        setDeleteArmed(false);
      }
      if (edge(buttons, BTN.RTRIGGER)) {
        // "Any world": drop the realm pin (and any invite) and reconnect
        // wherever the service has room. The way out of a full world.
        c.leaveRealm();
        showNotice("Joining any world…");
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
    } else if (dialogOpen()) {
      if (edge(buttons, BTN.CIRCLE)) advanceDialog();
    } else if (emoteOpen()) {
      // The picker: LEFT/RIGHT choose, CIRCLE sends and closes, CROSS or R
      // closes. A tap on a cell sends that one.
      if (edge(buttons, BTN.LEFT)) setEmoteSel((emoteSel() + EMOTE_CELLS - 1) % EMOTE_CELLS);
      if (edge(buttons, BTN.RIGHT)) setEmoteSel((emoteSel() + 1) % EMOTE_CELLS);
      if (edge(buttons, BTN.CIRCLE)) {
        c.sendEmote(EMOTE_TABLE[emoteSel()]!.id);
        setEmoteOpen(false);
      }
      if (edge(buttons, BTN.CROSS) || edge(buttons, BTN.RTRIGGER)) setEmoteOpen(false);
      const ts = touches();
      for (const t of ts) {
        if (prevTouchIds.has(t.id)) continue;
        const bar = emoteBarRect(vp.w, vp.h, debugOn());
        for (let i = 0; i < EMOTE_CELLS; i++) {
          const cell = emoteCell(bar, i);
          if (t.x >= cell.x0 && t.x < cell.x1 && t.y >= cell.y0 && t.y < cell.y1) {
            setEmoteSel(i);
            c.sendEmote(EMOTE_TABLE[i]!.id);
            setEmoteOpen(false);
            break;
          }
        }
      }
      prevTouchIds = new Set(ts.map((t) => t.id));
    } else {
      // TRIANGLE requests fast mode; the HUD says FAST once the server's
      // snapshot confirms it. CIRCLE talks, CROSS acts or pages the log,
      // R opens the emote picker.
      if (edge(buttons, BTN.TRIANGLE)) c.fastRequested = !c.fastRequested;
      if (edge(buttons, BTN.CIRCLE)) pressTalk(c);
      if (edge(buttons, BTN.CROSS)) pressAction(c);
      if (edge(buttons, BTN.RTRIGGER) && c.predictor instanceof RealmPredictor) setEmoteOpen(true);
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
  const logBar = () => logBarRect(viewport().w, viewport().h);
  const errandBar = () => errandBarRect(viewport().w, viewport().h);
  const dialogBox = () => dialogRect(viewport().w, viewport().h);
  const emoteBar = () => emoteBarRect(viewport().w, viewport().h, debugOn());

  return (
    <View class="w-full h-full overflow-hidden bg-black">
      {/* The field is an imperative node (the render ring draws into it)
          and stays mounted for the view's whole life: a node a Show
          unmounts is gone from the host, and re-inserting it after the
          creation screen would leave the world black. Other screens
          collapse it to nothing instead. */}
      <View class="absolute overflow-hidden" style={{ posType: 1, insetL: 0, insetT: 0, width: screen() === "world" ? viewport().w : 0, height: screen() === "world" ? viewport().h : 0 }} debugName="online-field">
        {fieldRoot as unknown as ReturnType<typeof View>}
      </View>
      <Show when={screen() === "world"}>
        <View class="absolute" style={{ posType: 1, ...rect(plate()), bgColor: "#0b1626", opacity: 0.84 }} debugName="online-plate" />
        <Text class="text-xs" style={{ posType: 1, insetT: plate().y0 + 2, insetL: 12, width: plate().x1 - 18, textColor: "#ffe97a", lineHeight: 12, height: 12 }}>{statusText()}</Text>
        <Text class="text-xs" style={{ posType: 1, insetT: plate().y0 + 15, insetL: 12, width: plate().x1 - 18, textColor: "#9fd0ff", lineHeight: 12, height: 12 }}>{nameLine()}</Text>
        <Text class="text-xs" style={{ posType: 1, insetT: plate().y0 + 28, insetL: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{posText()}</Text>
        <Show when={debugOn()}>
          <Text class="text-xs" style={{ posType: 1, insetT: plate().y0 + 41, insetL: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{debugText()}</Text>
        </Show>
        <Show when={!dialogOpen()}>
          <Show when={realmOn()}>
            <View class="absolute" style={{ posType: 1, ...rect(logBar()), bgColor: "#0b1626", opacity: 0.76 }} debugName="online-logline" />
            <Text class="text-xs" style={{ posType: 1, insetT: logBar().y0 + 2, insetL: 12, width: logBar().x1 - 12, textColor: "#ffe97a", lineHeight: 12, height: 12 }}>{logText()}</Text>
            <View class="absolute" style={{ posType: 1, ...rect(errandBar()), bgColor: "#0b1626", opacity: 0.76 }} debugName="online-errandline" />
            <Text class="text-xs" style={{ posType: 1, insetT: errandBar().y0 + 2, insetL: 12, width: errandBar().x1 - 12, textColor: "#ffb37a", lineHeight: 12, height: 12 }}>{errandText()}</Text>
          </Show>
          <View class="absolute" style={{ posType: 1, ...rect(helpRect(viewport().w, viewport().h)), bgColor: "#0b1626", opacity: 0.84 }} debugName="online-help" />
          <Text class="text-xs" style={{ posType: 1, insetT: helpRect(viewport().w, viewport().h).y0 + 2, insetL: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>
            D-PAD MOVE · O TALK · X ACT/LOG · TRI FAST · R EMOTE · SEL MENU
          </Text>
        </Show>
        <Show when={dialogOpen()}>
          <View class="absolute" style={{ posType: 1, ...rect(dialogBox()), bgColor: "#0b1626", borderWidth: 1, borderColor: "#3a4a6a" }} debugName="online-dialog" />
          {Array.from({ length: DIALOG_ROWS }, (_, i) => (
            <Text class="text-xs" style={{ posType: 1, insetT: dialogBox().y0 + 6 + i * DIALOG_ROW_H, insetL: dialogBox().x0 + 10, width: dialogBox().x1 - dialogBox().x0 - 20, textColor: "#e7edf8", lineHeight: 12, height: 12 }}>
              {dialogRows()[i] ?? ""}
            </Text>
          ))}
          <Text class="text-xs" style={{ posType: 1, insetT: dialogBox().y1 - 14, insetL: dialogBox().x1 - 56, width: 50, textColor: "#8ad0ff", lineHeight: 12, height: 12 }}>O next</Text>
        </Show>
        <Show when={emoteOpen()}>
          <View class="absolute" style={{ posType: 1, ...rect(emoteBar()), bgColor: "#0b1626", borderWidth: 1, borderColor: "#3a4a6a" }} debugName="online-emote-bar" />
          {EMOTE_TABLE.map((e, index) => {
            const cell = () => emoteCell(emoteBar(), index);
            return (
              <View
                class="absolute items-center justify-center"
                style={{ posType: 1, ...rect(cell()), bgColor: emoteSel() === index ? "#ffe17a" : "#1b2944" }}
                debugName={`online-emote-cell-${index}`}
              >
                <Text class="text-xs" style={{ textColor: emoteSel() === index ? "#0b1626" : "#e7edf8", lineHeight: 12, height: 12 }}>{`${e.glyph} ${e.word}`}</Text>
              </View>
            );
          })}
        </Show>
        <Show when={notice() !== "" && !emoteOpen()}>
          <View class="absolute flex-row justify-center" style={{ posType: 1, insetT: noticeRect(viewport().w, viewport().h, debugOn()).y0, insetL: 0, insetR: 0 }} debugName="online-notice">
            <View style={{ bgColor: "#0b1626", paddingL: 10, paddingR: 10, paddingT: 2, paddingB: 2 }}>
              <Text class="text-sm" style={{ textColor: "#8ad0ff", lineHeight: 18, height: 18 }}>{notice()}</Text>
            </View>
          </View>
        </Show>
        <Show when={menuOpen()}>
          <View class="absolute" style={{ posType: 1, ...rect(menu()), bgColor: "#0b1626", borderWidth: 1, borderColor: "#3a4a6a" }} debugName="online-menu" />
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 8, insetL: menu().x0 + 10, textColor: "#ffe97a", lineHeight: 14, height: 14 }}>MENU</Text>
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 26, insetL: menu().x0 + 10, textColor: "#c8d6ea", lineHeight: 14, height: 14 }}>CIRCLE: link device</Text>
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 40, insetL: menu().x0 + 10, textColor: deleteArmed() ? "#ffe97a" : "#c8d6ea", lineHeight: 14, height: 14 }}>
            {deleteArmed() ? "SQUARE: confirm delete" : "SQUARE: delete profile"}
          </Text>
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 54, insetL: menu().x0 + 10, textColor: "#c8d6ea", lineHeight: 14, height: 14 }}>
            {debugOn() ? "TRIANGLE: debug off" : "TRIANGLE: debug on"}
          </Text>
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 68, insetL: menu().x0 + 10, textColor: "#c8d6ea", lineHeight: 14, height: 14 }}>
            {menuAuto() ? "START: auto-walk off" : "START: auto-walk on"}
          </Text>
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 82, insetL: menu().x0 + 10, textColor: "#c8d6ea", lineHeight: 14, height: 14 }}>L: invite a friend</Text>
          <Text class="text-xs" style={{ posType: 1, insetT: menu().y0 + 96, insetL: menu().x0 + 10, textColor: "#c8d6ea", lineHeight: 14, height: 14 }}>R: any world · CROSS: close</Text>
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
