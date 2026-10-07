// examples/wander-online/shared/ticket-signer.ts — the HMAC session-ticket
// signer, in its own module so the client bundle never pulls in WebCrypto:
// the desktop QuickJS guest has no `crypto` global, and only the server
// sides (the Cloudflare Worker and the Bun dev server) sign or verify
// tickets. The wire contract (shape, TTL, version semantics) lives in
// auth.ts; this file is the server-side implementation of it.

import { TICKET_TTL_SEC } from "./auth.ts";

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export interface TicketClaims {
  githubId: number;
  /** Account profile version at issue time. */
  version: number;
  /** Expiry, unix seconds. */
  expiry: number;
}

/** Signs and verifies session tickets with an HMAC-SHA256 key. The key is
 *  generated once per deployment (by the Auth DO on first use) and persisted
 *  in DO storage; it never appears in any response. Both the Worker and Bun
 *  implement WebCrypto (crypto.subtle), so one implementation serves both. */
export class TicketSigner {
  private constructor(private readonly key: CryptoKey) {}

  /** A fresh random 256-bit key (first-use generation). */
  static async generate(): Promise<TicketSigner> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    return TicketSigner.fromRaw(raw);
  }

  static async fromRaw(raw: Uint8Array): Promise<TicketSigner> {
    // Copy into an ArrayBuffer-backed view: a DO storage value types as
    // Uint8Array<ArrayBufferLike>, which subtle crypto rejects.
    const bytes = new Uint8Array(raw);
    const key = await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: "SHA-256" },
      true, // extractable: toRaw() persists the key in DO storage
      ["sign", "verify"],
    );
    return new TicketSigner(key);
  }

  /** The raw key bytes, for durable storage. */
  async toRaw(): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.exportKey("raw", this.key));
  }

  /** Sign a ticket for `githubId`/`version`, expiring `ttlSec` after `now`
   *  (unix seconds). */
  async issue(githubId: number, version: number, now: number, ttlSec = TICKET_TTL_SEC): Promise<string> {
    const expiry = now + ttlSec;
    const payload = `${githubId}.${version}.${expiry}`;
    const sig = await this.signPayload(payload);
    return `${payload}.${sig}`;
  }

  /** Verify a ticket's shape, signature and expiry. Returns the claims, or
   *  null for anything malformed, tampered or expired. A version mismatch is
   *  NOT decided here (the caller loads the account and compares). */
  async verify(ticket: string, now: number): Promise<TicketClaims | null> {
    if (typeof ticket !== "string" || ticket.length > 256) return null;
    const parts = ticket.split(".");
    if (parts.length !== 4) return null;
    const [idStr, verStr, expStr, sig] = parts as [string, string, string, string];
    if (!/^\d{1,12}$/.test(idStr) || !/^\d{1,6}$/.test(verStr) || !/^\d{1,11}$/.test(expStr)) return null;
    const payload = `${idStr}.${verStr}.${expStr}`;
    if (!(await this.verifyPayload(payload, sig))) return null;
    const expiry = Number(expStr);
    if (expiry <= now) return null;
    return { githubId: Number(idStr), version: Number(verStr), expiry };
  }

  private async signPayload(payload: string): Promise<string> {
    const data = new TextEncoder().encode(payload);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", this.key, data));
    return b64urlEncode(sig);
  }

  private async verifyPayload(payload: string, sigB64: string): Promise<boolean> {
    const sig = b64urlDecode(sigB64);
    if (!sig) return false;
    const data = new TextEncoder().encode(payload);
    return crypto.subtle.verify("HMAC", this.key, sig, data);
  }
}
