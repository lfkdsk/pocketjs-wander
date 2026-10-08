import { afterEach, describe, expect, test } from "bun:test";
import { createSimFsHost, type SimFsHost } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/fs.ts";
import { clearTicket, loadTicket, saveTicket } from "../examples/wander-online/auth-store.ts";

const g = globalThis as {
  fs?: unknown;
  __pocketWebStore?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
};

let fsHost: SimFsHost | null = null;

afterEach(() => {
  fsHost?.dispose();
  fsHost = null;
  g.fs = undefined;
  g.__pocketWebStore = undefined;
});

describe("wander-online ticket persistence", () => {
  test("web storage survives a fresh load and logout removes the ticket", () => {
    const values = new Map<string, string>();
    g.__pocketWebStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    saveTicket("web-ticket");
    expect(loadTicket()).toBe("web-ticket");
    expect([...values.values()]).toEqual([JSON.stringify({ ticket: "web-ticket" })]);
    clearTicket();
    expect(loadTicket()).toBeNull();
    expect(values.size).toBe(0);
  });

  test("desktop save storage survives a fresh reader and clear invalidates it", () => {
    fsHost = createSimFsHost();
    g.fs = fsHost.ns;
    saveTicket("desktop-ticket");
    expect(fsHost.log.some((line) => line.startsWith("op write wander-online-ticket.json"))).toBe(true);
    expect(loadTicket()).toBe("desktop-ticket");
    clearTicket();
    expect(loadTicket()).toBeNull();
  });
});
