// examples/wander-online/create-text.ts — the creation screen's rejection
// lines, one per NameError code of shared/auth.ts, in English and Chinese.
//
// The Chinese half is built from code points rather than written literally:
// the PocketJS build scans every string literal in the module graph into the
// font atlas of every slot, and Han glyphs belong only to the 12 px slot the
// manifest bakes (see shared/name-charset.ts). Every character here is in
// that slot's set, so the line draws as glyphs on every host; the test
// checks that against the shared charset.

/** Decode a line written as space-separated hex code points. */
function han(hex: string): string {
  return String.fromCodePoint(...hex.split(" ").map((h) => parseInt(h, 16)));
}

/** Chinese rejection lines (GB 2312 level-1 characters only). */
export const CREATE_ERROR_TEXT_ZH: Readonly<Record<string, string>> = {
  "name-empty": han("540d 5b57 4e0d 80fd 4e3a 7a7a"), // the name cannot be empty
  "name-too-long": han("540d 5b57 6700 591a 31 32 4e2a 5b57"), // at most 12 characters
  "name-charset": han("540d 5b57 542b 6709 4e0d 5141 8bb8 7684 5b57 7b26"), // contains characters that are not allowed
  "name-blocked": han("540d 5b57 4e0d 88ab 5141 8bb8"), // the name is not allowed
  rejected: han("540d 5b57 88ab 62d2 7edd"), // the name was rejected
};

/** English rejection lines. Kept terse so the pair fits the footer at 480 px. */
export const CREATE_ERROR_TEXT_EN: Readonly<Record<string, string>> = {
  "name-empty": "Name is empty.",
  "name-too-long": "Name is too long.",
  "name-charset": "Name has invalid characters.",
  "name-blocked": "Name is not allowed.",
  rejected: "Name was rejected.",
};

/** The footer line for a rejection reason: English, a middle dot, Chinese.
 *  Unknown reasons (an older/newer server) read as a generic rejection. */
export function describeCreateError(reason: unknown): string {
  const key = typeof reason === "string" && reason in CREATE_ERROR_TEXT_EN ? reason : "rejected";
  return `${CREATE_ERROR_TEXT_EN[key]} · ${CREATE_ERROR_TEXT_ZH[key]}`;
}
