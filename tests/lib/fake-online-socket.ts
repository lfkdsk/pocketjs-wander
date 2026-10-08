// tests/lib/fake-online-socket.ts — an in-memory PocketSocket for sim tests.
// It plays the server side of the auth handshake without a real WebSocket:
// a github/ticket JOIN gets a scripted needCreate / WELCOME + ROSTER reply,
// so the OnlineView's screen state machine is testable on the sim host.
import type { PocketSocket, SocketCloseEvent } from "@pocketjs/framework/socket";
import {
  encodeRoster,
  encodeState,
  encodeState4,
  encodeWelcome,
  encodeWelcome4,
} from "../../examples/wander-online/net/protocol.ts";

export interface FakeOnlineOpts {
  /** "needCreate" (first login) or "welcome" (returning player). */
  mode: "needCreate" | "welcome" | "welcome4";
  login?: string;
  ticket?: string;
  name?: string;
  look?: number;
  /** Optional STATE population tail for HUD tests. */
  population?: { roomOnline: number; allOnline: number };
  /** Absolute v4 spawn. Defaults far outside the old frozen window so view
   * tests exercise signed world coordinates and an unclamped camera. */
  realm?: { tx?: number; ty?: number; seed?: number; epoch?: number; id?: string };
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
  return () => {
    let opened = false;
    let created = false;
    let state: "connecting" | "open" | "closing" | "closed" = "connecting";
    const sendWelcome = () => {
      if (opts.mode === "welcome4") {
        const tx = opts.realm?.tx ?? 640;
        const ty = opts.realm?.ty ?? -640;
        const seed = opts.realm?.seed ?? 0x5eed_0001;
        const epoch = opts.realm?.epoch ?? 7;
        sock.onMessage?.(new Uint8Array(encodeWelcome4({
          you: 1,
          seed,
          generatorVersion: 1,
          epoch,
          realmId: opts.realm?.id ?? "realm-test",
          realmRevision: 0,
          serverTimeMs: 0,
          mover: {
            tx, ty, px: 0, py: 0,
            dir: 0, phase: 0, stepDir: 0,
            moving: false, walking: false,
          },
        })));
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
        if (typeof data !== "string") return true;
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
            if (opts.mode === "needCreate" && !created) {
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
    // Open on the next microtask.
    queueMicrotask(() => {
      opened = true;
      state = "open";
      sock.onOpen?.();
    });
    return sock;
  };
}
