// tests/lib/fake-online-socket.ts — an in-memory PocketSocket for sim tests.
// It plays the server side of the auth handshake without a real WebSocket:
// a github/ticket JOIN gets a scripted needCreate / WELCOME + ROSTER reply,
// so the OnlineView's screen state machine is testable on the sim host.
import type { PocketSocket, SocketCloseEvent } from "@pocketjs/framework/socket";
import {
  MSG,
  decodeCommand,
  decodeInputBatch,
  encodeRoster,
  encodePlayerJourney,
  encodePlayerProgress,
  encodeRegionState,
  encodeState,
  encodeState4,
  encodeWelcome,
  encodeWelcome4,
  PLAYER_JOURNEY_BLOOM_WORDS,
  REGION_STATE_FLAG_INITIAL,
  type CommandMessage,
  type PlayerJourneyMessage,
  type WireEntity,
} from "../../examples/wander-online/net/protocol.ts";
import type { RealmRegionState } from "../../examples/wander-online/net/realm-state.ts";

/** A PLAYER_JOURNEY frame with every field defaulted to "nothing yet". */
export function journeyMessage(partial: Partial<PlayerJourneyMessage> = {}): PlayerJourneyMessage {
  return {
    revision: 0,
    eventSeq: 0,
    eventKind: 0,
    eventRx: 0,
    eventRy: 0,
    fast: false,
    errand: null,
    helpedCount: 0,
    bloom: new Array<number>(PLAYER_JOURNEY_BLOOM_WORDS).fill(0),
    helped: [],
    talked: [],
    ...partial,
  };
}

export interface FakeOnlineOpts {
  /** "needCreate" (first login, then a v3 welcome), "needCreate4" (first
   *  login, then the v4 realm welcome), "welcome" (returning player) or
   *  "welcome4" (returning player on the realm). */
  mode: "needCreate" | "needCreate4" | "welcome" | "welcome4";
  login?: string;
  ticket?: string;
  name?: string;
  look?: number;
  /** Optional STATE population tail for HUD tests. */
  population?: { roomOnline: number; allOnline: number };
  /** Absolute v4 spawn. Defaults far outside the old frozen window so view
   * tests exercise signed world coordinates and an unclamped camera. */
  realm?: { tx?: number; ty?: number; seed?: number; epoch?: number; id?: string };
  /** Display name carried by the current region's shared first-discovery row. */
  landmarkFirstName?: string;
  /** v4: the realm clock stamped on WELCOME4 and the initial REGION_STATE
   *  (default 0). With `discoveredAtMs` 0 a large value (10_000_000) makes
   *  every region's growth complete, so all residents are born. */
  serverTimeMs?: number;
  /** v4: discovery time of the default region rows (default 0). */
  discoveredAtMs?: number;
  /** v4: the initial REGION_STATE rows. Defaults to the 3x3 regions around
   *  the spawn (only the spawn region when `regionRows` is omitted AND no
   *  journey/progress/serverTimeMs option is set, keeping the legacy frame
   *  byte-identical). */
  regionRows?: readonly RealmRegionState[];
  /** v4: private landmark sightings sent in the initial PLAYER_PROGRESS. */
  progress?: readonly { rx: number; ry: number }[];
  /** v4: a PLAYER_JOURNEY sent right after PLAYER_PROGRESS. */
  journey?: Partial<PlayerJourneyMessage>;
  /** v4: every COMMAND frame the client sent, decoded, in order. */
  sentBinary?: CommandMessage[];
  /** Every button mask the client sent in INPUT_BATCH frames, in order. */
  sentInputs?: number[];
  /** v4: scripted reply to a COMMAND (null/undefined: no reply). */
  commandReply?: (cmd: CommandMessage) => Partial<PlayerJourneyMessage> | null | undefined;
  /** v4: answer every INPUT_BATCH with an empty STATE4 so long sim runs
   *  never trip the client's 2 s snapshot freeze. */
  heartbeat?: boolean;
  /** v4: remote entities every heartbeat STATE4 carries (default none). */
  heartbeatEntities?: () => WireEntity[];
  /** v4: scripted reply to a {"type":"inviteq"} (default: no reply). */
  inviteReply?: Record<string, unknown>;
  /** Every URL the factory was asked to open, in order. */
  urls?: string[];
  /** Observe each socket as it opens (tests push extra frames through it). */
  onSocket?: (sock: PocketSocket) => void;
  /** Scripted reply to a {"type":"delete"} message. Defaults to a
   *  deleteError so the deleteError path is exercised unless a test asks
   *  for the confirmed-delete path. */
  deleteReply?: { type: "deleted" } | { type: "deleteError"; reason: string };
  /** Replies consumed in order for desktop {"type":"linkr"} attempts. */
  linkReplies?: readonly (
    | { type: "linked"; ticket: string; login?: string }
    | { type: "linkError"; reason?: string }
  )[];
  /** Optional capture of every outbound JSON message. */
  sent?: Record<string, unknown>[];
}

/** A socket factory that returns a scripted fake socket. */
export function fakeOnlineSocketFactory(opts: FakeOnlineOpts): (url: string) => PocketSocket {
  const linkReplies = [...(opts.linkReplies ?? [])];
  return (url: string) => {
    opts.urls?.push(url);
    let opened = false;
    let created = false;
    let heartbeatFrame = 0;
    let state: "connecting" | "open" | "closing" | "closed" = "connecting";
    const realmMode = opts.mode === "welcome4" || opts.mode === "needCreate4";
    const sendWelcome = () => {
      if (realmMode) {
        const tx = opts.realm?.tx ?? 640;
        const ty = opts.realm?.ty ?? -640;
        const seed = opts.realm?.seed ?? 0x5eed_0001;
        const epoch = opts.realm?.epoch ?? 7;
        const serverTimeMs = opts.serverTimeMs ?? 0;
        const discoveredAtMs = opts.discoveredAtMs ?? 0;
        const rx0 = Math.floor(tx / 96), ry0 = Math.floor(ty / 96);
        const grown = opts.serverTimeMs !== undefined || opts.journey !== undefined || opts.progress !== undefined;
        let rows: RealmRegionState[] = [];
        if (opts.regionRows) rows = [...opts.regionRows];
        else if (!grown) {
          rows = [{
            rx: rx0, ry: ry0, discoveredAtMs,
            improvementLevel: 0, revision: 1, landmarkFirstName: opts.landmarkFirstName ?? "",
          }];
        } else {
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            rows.push({
              rx: rx0 + dx, ry: ry0 + dy, discoveredAtMs,
              improvementLevel: 0, revision: 1, landmarkFirstName: dx === 0 && dy === 0 ? opts.landmarkFirstName ?? "" : "",
            });
          }
        }
        sock.onMessage?.(new Uint8Array(encodeWelcome4({
          you: 1,
          seed,
          generatorVersion: 1,
          epoch,
          realmId: opts.realm?.id ?? "realm-test",
          realmRevision: 0,
          serverTimeMs,
          mover: {
            tx, ty, px: 0, py: 0,
            dir: 0, phase: 0, stepDir: 0,
            moving: false, walking: false,
          },
        })));
        sock.onMessage?.(new Uint8Array(encodeRegionState({
          flags: REGION_STATE_FLAG_INITIAL,
          realmRevision: 1,
          serverTimeMs,
          rows,
        })));
        sock.onMessage?.(new Uint8Array(encodePlayerProgress({ revision: 0, landmarks: [...(opts.progress ?? [])] })));
        if (opts.journey) sock.onMessage?.(new Uint8Array(encodePlayerJourney(journeyMessage(opts.journey))));
        sock.onMessage?.(new Uint8Array(encodeRoster([{ id: 1, name: opts.name ?? "Octo", look: opts.look ?? 0 }])));
        if (opts.population) {
          sock.onMessage?.(new Uint8Array(encodeState4(1, 0, epoch, [{
            id: 1, tx, ty, px: 0, py: 0,
            dir: 0, phase: 0, stepDir: 0,
            moving: false, walking: false, color: 0,
          }], opts.population)));
        }
        sock.onMessage?.(JSON.stringify({ type: "ready", ticket: opts.ticket ?? "dev-ticket" }));
        return;
      }
      const grid = new Uint8Array(96 * 96);
      // The framework socket delivers Uint8Array, not ArrayBuffer.
      sock.onMessage?.(new Uint8Array(encodeWelcome(1, 0x5eed_0001, 0, 0, grid)));
      sock.onMessage?.(new Uint8Array(encodeRoster([{ id: 1, name: opts.name ?? "Octo", look: opts.look ?? 0 }])));
      if (opts.population) {
        sock.onMessage?.(new Uint8Array(encodeState(1, 0, [{
          id: 1,
          tx: 48,
          ty: 48,
          px: 0,
          py: 0,
          dir: 0,
          phase: 0,
          stepDir: 0,
          moving: false,
          walking: false,
          color: 0,
        }], opts.population)));
      }
      sock.onMessage?.(JSON.stringify({ type: "ready", ticket: opts.ticket ?? "dev-ticket" }));
    };
    const sock: PocketSocket = {
      url: "fake://online",
      protocol: "",
      get readyState() {
        return state;
      },
      onOpen: undefined,
      onMessage: undefined,
      onClose: undefined,
      onError: undefined,
      send(data: string | ArrayBuffer): boolean {
        if (!opened) return false;
        if (typeof data !== "string") {
          const bytes = new Uint8Array(data);
          if (bytes.length > 0 && bytes[0] === MSG.command) {
            const cmd = decodeCommand(bytes);
            if (cmd) {
              opts.sentBinary?.push(cmd);
              const reply = opts.commandReply?.(cmd);
              if (reply) {
                const frame = new Uint8Array(encodePlayerJourney(journeyMessage(reply)));
                queueMicrotask(() => sock.onMessage?.(frame));
              }
            }
          } else if (bytes.length > 0 && bytes[0] === MSG.inputBatch) {
            if (opts.sentInputs) {
              const batch = decodeInputBatch(bytes);
              if (batch) for (const mask of batch.buttons) opts.sentInputs.push(mask);
            }
            if (opts.heartbeat && realmMode) {
              const frame = new Uint8Array(encodeState4(++heartbeatFrame, 0, opts.realm?.epoch ?? 7, opts.heartbeatEntities?.() ?? [], opts.population));
              queueMicrotask(() => sock.onMessage?.(frame));
            }
          }
          return true;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data);
        } catch {
          return true;
        }
        opts.sent?.push(msg);
        // Reply on the next microtask so the client's send returns first.
        queueMicrotask(() => {
          if (msg.type === "join") {
            if ((opts.mode === "needCreate" || opts.mode === "needCreate4") && !created) {
              sock.onMessage?.(JSON.stringify({ type: "needCreate", login: opts.login ?? "octo", ticket: opts.ticket ?? "dev-ticket" }));
            } else {
              sendWelcome();
            }
          } else if (msg.type === "create") {
            created = true;
            sock.onMessage?.(JSON.stringify({ type: "createOk" }));
          } else if (msg.type === "delete") {
            const reply = opts.deleteReply ?? { type: "deleteError", reason: "delete-unavailable" };
            sock.onMessage?.(JSON.stringify(reply));
          } else if (msg.type === "linkr") {
            const reply = linkReplies.shift();
            if (reply) sock.onMessage?.(JSON.stringify(reply));
          } else if (msg.type === "inviteq") {
            if (opts.inviteReply) sock.onMessage?.(JSON.stringify(opts.inviteReply));
          }
        });
        return true;
      },
      close(code = 1000, reason = ""): void {
        if (!opened) return;
        opened = false;
        state = "closed";
        const ev: SocketCloseEvent = { code, reason, clean: code === 1000 };
        sock.onClose?.(ev);
      },
    };
    opts.onSocket?.(sock);
    // Open on the next microtask.
    queueMicrotask(() => {
      opened = true;
      state = "open";
      sock.onOpen?.();
    });
    return sock;
  };
}
