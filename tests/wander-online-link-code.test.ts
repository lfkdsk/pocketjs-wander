import { describe, expect, test } from "bun:test";
import {
  LINK_PAD_KEYS,
  moveLinkCursor,
  stepLinkCode,
  type LinkCodeState,
} from "../examples/wander-online/link-code.ts";

function activate(state: LinkCodeState): LinkCodeState {
  return stepLinkCode(state, { type: "activate" }).state;
}

describe("wander-online desktop link-code keypad", () => {
  test("all ten server-generated digits can be entered", () => {
    for (const digit of "0123456789") {
      const state = activate({ code: "", cursor: LINK_PAD_KEYS.indexOf(digit as (typeof LINK_PAD_KEYS)[number]) });
      expect(state.code).toBe(digit);
    }
    expect(LINK_PAD_KEYS.filter((key) => /^\d$/.test(key)).sort()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  test("movement wraps the 3x4 pad and backspace permits correction", () => {
    expect(moveLinkCursor(0, -1, 0)).toBe(2);
    expect(moveLinkCursor(0, 0, -1)).toBe(9);
    let state: LinkCodeState = { code: "012345", cursor: 9 };
    state = activate(state);
    expect(state.code).toBe("01234");
    state = stepLinkCode(state, { type: "backspace" }).state;
    expect(state.code).toBe("0123");
  });

  test("submit requires exactly six digits and returns the full code", () => {
    const cursor = LINK_PAD_KEYS.indexOf("submit");
    expect(stepLinkCode({ code: "01234", cursor }, { type: "activate" }).submit).toBeNull();
    expect(stepLinkCode({ code: "012345", cursor }, { type: "activate" }).submit).toBe("012345");
  });
});
