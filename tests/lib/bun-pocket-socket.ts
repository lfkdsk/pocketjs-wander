// tests/lib/bun-pocket-socket.ts — a PocketSocket backed by Bun's WebSocket,
// so the OnlineClient lifecycle (join, reconnect, freeze) can be tested
// against a real loopback server without a PocketJS host. Mirrors the
// contract the SDK's Socket class implements; drop() simulates a transport
// failure (an abnormal close with no handshake).
import type { PocketSocket, SocketCloseEvent, SocketError } from "@pocketjs/framework/socket";

export interface BunPocketSocket extends PocketSocket {
  /** Simulate a transport drop: close the underlying socket and deliver an
   *  abnormal close event, as if the network vanished. */
  drop(): void;
}

export function bunSocketFactory(url: string): BunPocketSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let state: "connecting" | "open" | "closing" | "closed" = "connecting";
  const sock: BunPocketSocket = {
    url,
    protocol: "",
    get readyState() {
      return state;
    },
    onOpen: undefined,
    onMessage: undefined,
    onClose: undefined,
    onError: undefined,
    send(data) {
      if (state !== "open") throw new Error("socket: socket is not open");
      ws.send(data as string | ArrayBuffer);
      return true;
    },
    close(code = 1000, reason = "") {
      if (state === "connecting" || state === "open") {
        state = "closing";
        try {
          ws.close(code, reason);
        } catch {
          // already closing
        }
      }
    },
    drop() {
      if (state === "closed") return;
      state = "closed";
      try {
        ws.close();
      } catch {
        // already closed
      }
      sock.onClose?.({ code: 1006, reason: "abnormal drop", clean: false });
    },
  };
  ws.addEventListener("open", () => {
    state = "open";
    sock.onOpen?.();
  });
  ws.addEventListener("message", (ev) => {
    const d = ev.data as string | ArrayBuffer;
    sock.onMessage?.(typeof d === "string" ? d : new Uint8Array(d));
  });
  ws.addEventListener("close", (ev) => {
    // drop() already synthesized the close event.
    if (state === "closed") return;
    state = "closed";
    const event: SocketCloseEvent = {
      code: typeof ev.code === "number" && ev.code > 0 ? ev.code : 1006,
      reason: typeof ev.reason === "string" ? ev.reason : "",
      clean: ev.wasClean === true,
    };
    sock.onClose?.(event);
  });
  ws.addEventListener("error", () => {
    sock.onError?.(new Error("socket: connection failed") as SocketError);
  });
  return sock;
}
