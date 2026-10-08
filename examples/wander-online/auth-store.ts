// examples/wander-online/auth-store.ts — where the session ticket lives.
//
// The ticket is the only credential after the first GitHub exchange. It is
// stored on the device: browser localStorage on web, the app's save
// directory on desktop (via the kit's fs host module). The GitHub OAuth
// token itself is never persisted — the page hands it to the game once and
// the game swaps it for a ticket immediately.

import { file, write, fsHost } from "@pocketjs/framework/fs";

const WEB_KEY = "pocket-rpgkit:wander-online:ticket";
const FS_PATH = "wander-online-ticket.json";

declare global {
  // eslint-disable-next-line no-var
  var __pocketWebStore:
    | { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
    | undefined;
}

/** The browser's localStorage, installed by the web player page. The
 *  desktop QuickJS guest has no localStorage global (and the fs path above
 *  is used there instead). */
function webStore() {
  try {
    return globalThis.__pocketWebStore ?? null;
  } catch {
    return null;
  }
}

/** Whether the fs host module is mounted (desktop builds). On web the fs
 *  module is absent, so we fall back to localStorage. */
function hasFs(): boolean {
  try {
    return fsHost() !== null;
  } catch {
    return false;
  }
}

export function loadTicket(): string | null {
  try {
    if (hasFs()) {
      const f = file(FS_PATH);
      if (!f.exists()) return null;
      const parsed = JSON.parse(f.text()) as { ticket?: string };
      return typeof parsed.ticket === "string" ? parsed.ticket : null;
    }
    const store = webStore();
    if (!store) return null;
    const v = store.getItem(WEB_KEY);
    return v ? ((JSON.parse(v) as { ticket?: string }).ticket ?? null) : null;
  } catch {
    return null;
  }
}

export function saveTicket(ticket: string): void {
  try {
    if (hasFs()) {
      write(FS_PATH, JSON.stringify({ ticket }));
      return;
    }
    const store = webStore();
    if (!store) return;
    store.setItem(WEB_KEY, JSON.stringify({ ticket }));
  } catch {
    // private mode / quota: the ticket simply does not persist
  }
}

export function clearTicket(): void {
  try {
    if (hasFs()) {
      write(FS_PATH, JSON.stringify({ ticket: null }));
      return;
    }
    const store = webStore();
    if (!store) return;
    store.removeItem(WEB_KEY);
  } catch {
    // already gone
  }
}
