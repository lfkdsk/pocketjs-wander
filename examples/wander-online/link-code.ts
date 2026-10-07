// Controller-friendly six-digit device-code entry. The 3x4 keypad mirrors
// a telephone keypad and keeps all state in plain numbers/strings so it can
// run in the desktop QuickJS guest and be tested without rendering.

export const LINK_CODE_LENGTH = 6;
export const LINK_PAD_COLS = 3;
export const LINK_PAD_KEYS = [
  "1", "2", "3",
  "4", "5", "6",
  "7", "8", "9",
  "back", "0", "submit",
] as const;

export type LinkPadKey = (typeof LINK_PAD_KEYS)[number];

export interface LinkCodeState {
  code: string;
  cursor: number;
}

export type LinkCodeAction =
  | { type: "move"; dx: number; dy: number }
  | { type: "activate" }
  | { type: "backspace" };

export interface LinkCodeResult {
  state: LinkCodeState;
  submit: string | null;
}

export function moveLinkCursor(cursor: number, dx: number, dy: number): number {
  const rows = LINK_PAD_KEYS.length / LINK_PAD_COLS;
  const col = cursor % LINK_PAD_COLS;
  const row = Math.floor(cursor / LINK_PAD_COLS);
  const nextCol = (col + dx + LINK_PAD_COLS) % LINK_PAD_COLS;
  const nextRow = (row + dy + rows) % rows;
  return nextRow * LINK_PAD_COLS + nextCol;
}

export function stepLinkCode(state: LinkCodeState, action: LinkCodeAction): LinkCodeResult {
  if (action.type === "move") {
    return {
      state: { code: state.code, cursor: moveLinkCursor(state.cursor, action.dx, action.dy) },
      submit: null,
    };
  }
  if (action.type === "backspace") {
    return { state: { code: state.code.slice(0, -1), cursor: state.cursor }, submit: null };
  }
  const key = LINK_PAD_KEYS[state.cursor] ?? "1";
  if (key === "back") {
    return { state: { code: state.code.slice(0, -1), cursor: state.cursor }, submit: null };
  }
  if (key === "submit") {
    return { state, submit: state.code.length === LINK_CODE_LENGTH ? state.code : null };
  }
  if (state.code.length >= LINK_CODE_LENGTH) return { state, submit: null };
  return { state: { code: state.code + key, cursor: state.cursor }, submit: null };
}
