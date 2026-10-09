// tests/wander-online-name-input.test.ts — the creation grid and the shared
// name rule agree character for character: the grid offers exactly the
// ASCII the validator accepts (mutation: add "!" to the grid or drop "_"
// from it and the equality below breaks), the engine keeps every cell, and
// the bilingual rejection lines draw with the baked name font.
import { describe, expect, test } from "bun:test";
import { nameInputRules, type NameInputState } from "../vendor/pocket-rpgkit/src/engine/name-input.ts";
import { NAME_MAX, validateName } from "../examples/wander-online/shared/auth.ts";
import {
  NAME_ASCII_CHARSET,
  NAME_ASCII_DIGITS,
  NAME_ASCII_LETTERS,
  NAME_ASCII_SEPARATORS,
  hanLevel1,
  nameCodePointAllowed,
  nameGridCharset,
} from "../examples/wander-online/shared/name-charset.ts";
import { CREATE_ERROR_TEXT_EN, CREATE_ERROR_TEXT_ZH, describeCreateError } from "../examples/wander-online/create-text.ts";

/** Every ASCII code point the shared rule accepts, as characters. */
function allowedAscii(): string[] {
  const out: string[] = [];
  for (let cp = 0; cp < 0x80; cp++) if (nameCodePointAllowed(cp)) out.push(String.fromCodePoint(cp));
  return out;
}

/** The grid as the app starts it: the same args OnlineView passes. */
function startGrid(): NameInputState {
  const started = nameInputRules.start(
    null,
    { default: "player", maxLength: NAME_MAX, title: "Your Name", charset: nameGridCharset() },
    0,
    { variables: {}, playerName: "" } as never,
  );
  return started!.state as unknown as NameInputState;
}

describe("wander-online creation grid vs the shared name rule", () => {
  test("the grid is exactly the ASCII the validator accepts, one cell per character", () => {
    const grid = nameGridCharset();
    expect(new Set(grid).size, "no duplicate cells").toBe(grid.length);
    expect([...grid].sort()).toEqual(allowedAscii().sort());
    for (const ch of grid) expect(validateName(`a${ch}b`), `cell ${JSON.stringify(ch)} is accepted`).toBeNull();
    // What the server refuses is not a cell: the old default grid's ' ! ?
    // would each be bounced with name-charset.
    for (const ch of "'!?") {
      expect(grid.includes(ch)).toBe(false);
      expect(validateName(`a${ch}b`)).toBe("name-charset");
    }
    // The separators the server allows are cells.
    for (const ch of " _.-") expect(grid.includes(ch)).toBe(true);
  });

  test("the grid, the validator and the charset constant derive from one string", () => {
    expect(NAME_ASCII_CHARSET).toBe(NAME_ASCII_LETTERS + NAME_ASCII_DIGITS + NAME_ASCII_SEPARATORS);
    expect(nameGridCharset().join("")).toBe(NAME_ASCII_CHARSET);
    expect(allowedAscii().join("")).toBe([...NAME_ASCII_CHARSET].sort().join(""));
    expect(NAME_ASCII_SEPARATORS).toBe(" _.-");
  });

  test("the engine keeps every cell and the app's length cap", () => {
    const state = startGrid();
    expect(state.charset).toEqual(nameGridCharset());
    expect(state.maxLength).toBe(NAME_MAX);
    // 66 cells + BACK/OK/CANCEL on 10 columns: seven rows, inside the
    // scene's eight-row panel.
    expect(state.columns).toBe(10);
    expect(state.rows).toBe(7);
    // Every cell is a printable single character the engine would not
    // drop (it filters C* and line separators out of custom charsets).
    expect(state.charset.length).toBe(66);
  });

  test("a name typed only from grid cells is always accepted by the validator", () => {
    const grid = nameGridCharset();
    // Walk the grid in a few strides so every cell lands in some name.
    for (let start = 0; start < grid.length; start += 1) {
      const name = Array.from({ length: Math.min(NAME_MAX, grid.length - start) }, (_, i) => grid[start + i]!).join("");
      const trimmed = name.trim();
      if (trimmed.length === 0) continue;
      const refused = validateName(trimmed);
      // Only the blocklist may refuse a grid-typed name, never the charset.
      expect(refused === null || refused === "name-blocked", `${JSON.stringify(trimmed)} -> ${refused}`).toBe(true);
    }
  });
});

describe("wander-online creation rejection lines", () => {
  test("every reason has an English and a Chinese line, and both draw with the name font", () => {
    for (const reason of ["name-empty", "name-too-long", "name-charset", "name-blocked", "rejected"]) {
      const zh = CREATE_ERROR_TEXT_ZH[reason]!;
      const en = CREATE_ERROR_TEXT_EN[reason]!;
      expect(zh.length).toBeGreaterThan(0);
      expect(en.length).toBeGreaterThan(0);
      for (const ch of zh) {
        const cp = ch.codePointAt(0)!;
        expect(nameCodePointAllowed(cp), `U+${cp.toString(16)} of ${reason} is baked`).toBe(true);
      }
      expect([...zh].some((ch) => hanLevel1().has(ch.codePointAt(0)!)), `${reason} has Chinese`).toBe(true);
      expect(describeCreateError(reason)).toBe(`${en} · ${zh}`);
    }
    expect(describeCreateError("something-new")).toBe(describeCreateError("rejected"));
    expect(describeCreateError(undefined)).toBe(describeCreateError("rejected"));
  });
});
