// examples/wander-online/shared/utf8.ts — UTF-8 codec for the wire protocol.
//
// The desktop QuickJS guest has no TextEncoder/TextDecoder globals, so the
// ROSTER codec cannot use them. This is the same well-formed encoding the
// framework's bytes module uses (lone surrogates become U+FFFD on encode;
// malformed sequences throw on decode), kept local so the online example
// needs no engine change.

/** UTF-8 encode. Lone surrogates become U+FFFD, so the output is always
 *  well-formed UTF-8 (the byte shape every module boundary requires). */
export function stringToUtf8(s: string): Uint8Array {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i)!;
    if (code > 0xffff) i++;
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let code = s.codePointAt(i)!;
    if (code > 0xffff) i++;
    else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out[o++] = code;
    else if (code < 0x800) {
      out[o++] = 0xc0 | (code >> 6);
      out[o++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[o++] = 0xe0 | (code >> 12);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    } else {
      out[o++] = 0xf0 | (code >> 18);
      out[o++] = 0x80 | ((code >> 12) & 0x3f);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

/** UTF-8 decode, strict: malformed sequences throw (a corrupt ROSTER entry
 *  is dropped by the caller before this runs). */
export function utf8ToString(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const a = bytes[i++]!;
    if (a < 0x80) {
      out += String.fromCharCode(a);
      continue;
    }
    let n: number;
    let extra: number;
    if ((a & 0xe0) === 0xc0) {
      n = a & 0x1f;
      extra = 1;
    } else if ((a & 0xf0) === 0xe0) {
      n = a & 0x0f;
      extra = 2;
    } else if ((a & 0xf8) === 0xf0) {
      n = a & 0x07;
      extra = 3;
    } else {
      throw new Error("invalid UTF-8");
    }
    if (i + extra > bytes.length) throw new Error("invalid UTF-8");
    for (let k = 0; k < extra; k++) {
      const b = bytes[i++]!;
      if ((b & 0xc0) !== 0x80) throw new Error("invalid UTF-8");
      n = (n << 6) | (b & 0x3f);
    }
    if (n > 0xffff) {
      const c = n - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else {
      out += String.fromCharCode(n);
    }
  }
  return out;
}
