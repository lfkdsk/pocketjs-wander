# Noto Sans CJK SC subset (Wander Online names)

`NotoSansCJKsc-subset.otf` is the fallback face for the characters a Wander Online display name may
contain. `../fonts.json` lists it for the 12 px slot only (the HUD lines, name tags and the
first-discoverer suffix) and `cjk-charset.txt` as a character file, so the PocketJS build bakes
every listed character into that slot from this face. `shared/name-charset.ts` validates names
against the same set on the client and the server.

- Source: [NotoSansCJKsc-Regular.otf](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf)
  at commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c`.
- Source SHA-256: `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b` (16437364 bytes).
- Characters: 3755 (GB 2312 level 1, rows 0xB0..0xD7, derived from the encoding).
- Subset size: 1044172 bytes.

Each glyph keeps the source advance width and outline; hinting and OpenType layout tables are
not carried over. Regenerate with `bun tools/wander-online-cjk-font.ts` (the source font is
downloaded once and cached); `--check` verifies the committed files without network access.

The font is licensed under the SIL Open Font License 1.1; the copyright notice and the license
text are in `LICENSE-NotoSansCJK.txt`, shipped inside the app's pak as `license:NotoSansCJK.txt`. The subset is a
Modified Version under that license and is renamed "Noto Sans CJK SC Subset".
