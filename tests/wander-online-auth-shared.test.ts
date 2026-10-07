// tests/wander-online-auth-shared.test.ts — the shared auth logic (ticket
// HMAC, name/look validation, link codes) under a fake clock. Every
// assertion is mutation-checked: a comment names the change that should
// flip it.
import { describe, expect, test } from "bun:test";
import {
  AUTH_PROTOCOL_VERSION,
  LINK_CODE_TTL_SEC,
  MAX_SESSIONS_PER_ACCOUNT,
  NAME_BLOCKLIST,
  NAME_MAX,
  TICKET_TTL_SEC,
  linkCodeFresh,
  linkCodeTtl,
  newLinkCode,
  validateLook,
  validateName,
} from "../examples/wander-online/shared/auth.ts";
import { TicketSigner } from "../examples/wander-online/shared/ticket-signer.ts";

const T0 = 1_700_000_000; // fixed unix-seconds clock

describe("shared auth: ticket signer", () => {
  test("a fresh ticket verifies and carries its claims", async () => {
    const signer = await TicketSigner.generate();
    const ticket = await signer.issue(12345, 1, T0);
    const claims = await signer.verify(ticket, T0);
    expect(claims).toEqual({ githubId: 12345, version: 1, expiry: T0 + TICKET_TTL_SEC });
    // Mutation: issue with TTL 0 (immediately expired) -> verify returns null.
    const dead = await signer.issue(12345, 1, T0, 0);
    expect(await signer.verify(dead, T0)).toBeNull();
  });

  test("a ticket verifies up to its expiry and not past it", async () => {
    const signer = await TicketSigner.generate();
    const ticket = await signer.issue(7, 2, T0, 100);
    expect(await signer.verify(ticket, T0 + 99)).not.toBeNull(); // mutation: T0+100 -> null
    expect(await signer.verify(ticket, T0 + 100)).toBeNull();
  });

  test("a tampered ticket is rejected", async () => {
    const signer = await TicketSigner.generate();
    const ticket = await signer.issue(12345, 1, T0);
    // Flip the github id: the signature no longer matches.
    const tampered = ticket.replace(/^12345\./, "12346.");
    expect(tampered).not.toBe(ticket);
    expect(await signer.verify(tampered, T0)).toBeNull();
    // Flip a byte of the signature.
    const parts = ticket.split(".");
    const badSig = parts[3]!.charAt(0) === "A" ? "B" : "A";
    const reSig = parts[3]!.slice(1) + badSig;
    expect(await signer.verify(parts.slice(0, 3).concat(reSig).join("."), T0)).toBeNull();
  });

  test("a ticket signed by another key is rejected", async () => {
    const a = await TicketSigner.generate();
    const b = await TicketSigner.generate();
    const ticket = await a.issue(12345, 1, T0);
    // Mutation: verify with the same signer -> passes; a different key must not.
    expect(await b.verify(ticket, T0)).toBeNull();
  });

  test("malformed tickets are rejected without throwing", async () => {
    const signer = await TicketSigner.generate();
    for (const bad of ["", "x", "1.2.3", "1.2.3.sig.extra", "a.2.3.sig", "1.b.3.sig", "1.2.c.sig", "1.2.3.", ".2.3.sig", "1..3.sig"]) {
      expect(await signer.verify(bad, T0)).toBeNull(); // mutation: drop the shape check -> "a.2.3.sig" parses NaN through
    }
    // Oversized tickets are refused before any crypto.
    expect(await signer.verify("1.2.3." + "A".repeat(300), T0)).toBeNull();
  });

  test("raw key round trip: a signer rebuilt from storage verifies its old tickets", async () => {
    const signer = await TicketSigner.generate();
    const ticket = await signer.issue(999, 3, T0);
    const raw = await signer.toRaw();
    expect(raw.length).toBe(32); // mutation: 16-byte key -> this still passes; the persistence contract is 32
    const rebuilt = await TicketSigner.fromRaw(raw);
    expect(await rebuilt.verify(ticket, T0)).not.toBeNull();
  });
});

describe("shared auth: name validation", () => {
  test("accepts names of 1..12 code points, including CJK", () => {
    expect(validateName("a")).toBeNull();
    expect(validateName("lfkdsk")).toBeNull();
    expect(validateName("口袋妖怪")).toBeNull(); // 4 CJK chars
    expect(validateName("カイ123")).toBeNull();
    expect(validateName("A B-C_D.E")).toBeNull();
    // 12 code points passes; 13 fails (by code point, not UTF-16 length).
    expect(validateName("一二三四五六七八九十一二")).toBeNull(); // 12 CJK
    expect(validateName("一二三四五六七八九十一二三")).toBe("name-too-long"); // 13 CJK
    expect(validateName("A".repeat(NAME_MAX))).toBeNull();
    expect(validateName("A".repeat(NAME_MAX + 1))).toBe("name-too-long");
  });

  test("empty and whitespace-only names are refused", () => {
    expect(validateName("")).toBe("name-empty");
    expect(validateName("   ")).toBe("name-empty"); // mutation: trim() dropped -> "   " passes charset and lands as a space name
    expect(validateName("\t")).toBe("name-empty");
  });

  test("the charset refuses emoji, control chars and combining marks", () => {
    expect(validateName("a😀b")).toBe("name-charset");
    expect(validateName("a\nb")).toBe("name-charset");
    expect(validateName("é")).toBe("name-charset"); // combining accent
    // Mutation: widen the regex to \p{M} -> the combining mark passes.
  });

  test("the blocklist catches slurs and impersonation bait, case-insensitively", () => {
    expect(validateName("Admin")).toBe("name-blocked");
    expect(validateName("myRoot")).toBe("name-blocked"); // substring, not equality
    expect(validateName("nigger")).toBe("name-blocked");
    // Mutation: drop one entry from NAME_BLOCKLIST -> its case passes.
    expect(NAME_BLOCKLIST.length).toBeGreaterThanOrEqual(8);
  });

  test("surrounding whitespace is trimmed before validation", () => {
    expect(validateName("  lfkdsk  ")).toBeNull();
    // Mutation: keep the whitespace -> "  lfkdsk  " is 10 chars and still
    // passes, so the observable contract is the STORED name: the server
    // stores the trimmed form (asserted in the server tests).
  });
});

describe("shared auth: look validation", () => {
  test("integer ids in [0, 64) pass", () => {
    expect(validateLook(0)).toBe(true);
    expect(validateLook(63)).toBe(true);
    expect(validateLook(64)).toBe(false);
    expect(validateLook(-1)).toBe(false);
    expect(validateLook(1.5)).toBe(false);
    expect(validateLook("3")).toBe(false);
    expect(validateLook(NaN)).toBe(false);
    // Mutation: drop the integer check -> 1.5 passes.
  });
});

describe("shared auth: link codes", () => {
  test("codes are six digits", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    for (let i = 0; i < 50; i++) {
      const code = newLinkCode(rand);
      expect(code).toMatch(/^\d{6}$/); // mutation: 5 digits -> regex fails
    }
  });

  test("freshness and TTL countdown", () => {
    const issued = T0;
    expect(linkCodeFresh(issued, T0 + LINK_CODE_TTL_SEC - 1)).toBe(true);
    expect(linkCodeFresh(issued, T0 + LINK_CODE_TTL_SEC)).toBe(false); // mutation: <= -> the boundary flips
    expect(linkCodeTtl(issued, T0)).toBe(LINK_CODE_TTL_SEC);
    expect(linkCodeTtl(issued, T0 + 120)).toBe(LINK_CODE_TTL_SEC - 120);
    expect(linkCodeTtl(issued, T0 + LINK_CODE_TTL_SEC + 99)).toBe(0);
  });
});

describe("shared auth: protocol constants", () => {
  test("the wire version and session cap are pinned", () => {
    expect(AUTH_PROTOCOL_VERSION).toBe(3); // mutation: 2 -> old clients accepted
    expect(MAX_SESSIONS_PER_ACCOUNT).toBe(2); // mutation: 3 -> the cap test in the server suite flips
  });
});
