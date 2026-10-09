// examples/wander-online/net/emote.ts — the preset emote table, shared by the
// client, the local Bun server and the hosted Room DO. An emote is one byte
// on the wire (COMMAND.emote with `extra` = id; EMOTE id u32 + emote u8 back
// to the AOI). There is deliberately no free-text form: the only thing a
// player can "say" is one of these ids.

export const EMOTE = {
  wave: 1,
  cheer: 2,
  point: 3,
  question: 4,
  gather: 5,
} as const;

export type EmoteId = (typeof EMOTE)[keyof typeof EMOTE];

export const EMOTE_COUNT = 5;

/** What the bubble above a walker shows (ASCII, so every font slot has it)
 *  and the picker's word for it. */
export const EMOTE_TABLE: readonly { id: EmoteId; glyph: string; word: string }[] = [
  { id: EMOTE.wave, glyph: "o/", word: "WAVE" },
  { id: EMOTE.cheer, glyph: "\\o/", word: "CHEER" },
  { id: EMOTE.point, glyph: "->", word: "POINT" },
  { id: EMOTE.question, glyph: "?", word: "WHAT" },
  { id: EMOTE.gather, glyph: "!!", word: "GATHER" },
];

/** How long a bubble stays above the walker. Nothing is persisted: a late
 *  joiner never sees an emote sent before it arrived. */
export const EMOTE_SHOW_MS = 5000;
/** Server-side floor between two emotes from one player; a faster second
 *  emote is dropped silently (not a protocol violation, not a close). */
export const EMOTE_MIN_INTERVAL_MS = 1000;

export function isEmoteId(value: number): value is EmoteId {
  return Number.isInteger(value) && value >= 1 && value <= EMOTE_COUNT;
}

export function emoteGlyph(id: number): string {
  return EMOTE_TABLE.find((e) => e.id === id)?.glyph ?? "";
}
