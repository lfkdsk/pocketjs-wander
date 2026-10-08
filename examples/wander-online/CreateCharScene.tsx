// examples/wander-online/CreateCharScene.tsx — the full-screen character
// creation scene: name input on the left, a large animated look preview on
// the right.
//
// The name-input state machine (src/engine/name-input.ts) owns the buffer
// and cursor; this component is presentation plus the look preview. The
// parent (OnlineView) drives the rules once per host frame and passes a
// fresh state object, so the scene re-renders every frame it is shown.
//
// Input model: the scene has two focus zones. NAME focus: the d-pad moves
// the charset cursor, CIRCLE types / confirms. LOOK focus: LEFT/RIGHT cycle
// the base character, UP/DOWN the palette. L1/R1 toggles focus. The preview
// walks in place and rotates through the four directions on its own.

import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createElement, insertNode, setProp } from "@pocketjs/framework/renderer";
import { getOps } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { TileTextureCache } from "../../vendor/pocket-rpgkit/src/ui/tile-texture-cache.ts";
import { walkPose } from "../../vendor/pocket-rpgkit/src/engine/movement.ts";
import { WANDER_LOOKS } from "../wander/assets-wander.ts";
import { LOOK_BASE_NAMES, LOOK_COUNT, LOOK_PALETTES } from "../wander/looks.ts";
import {
  NAME_INPUT_UI_TEXT,
  nameInputCharAt,
  type NameInputState,
} from "../../vendor/pocket-rpgkit/src/engine/name-input.ts";
import { withUiText } from "../../vendor/pocket-rpgkit/src/engine/ui-text.ts";
import {
  createEditBox,
  createLayout,
  createNameGrid,
  createTitleRect,
  type CreateLayout,
  type HudRect,
} from "./hud.ts";

export type CreateFocus = "name" | "look";

export interface CreateCharSceneProps {
  state: NameInputState;
  look: number;
  focus: CreateFocus;
  width: number;
  height: number;
}

const COLOURS = {
  panelBg: "#141c30",
  panelBorder: "#4a5f8f",
  activeBorder: "#ffe17a",
  title: "#ffe17a",
  editBg: "#0b1626",
  editBorder: "#3a4a6a",
  buffer: "#ffffff",
  padding: "#3a4a6a",
  cell: "#c8d4f0",
  cursorBg: "#ffe17a",
  cursorText: "#0b1626",
  previewBg: "#0b1626",
  label: "#9fd0ff",
};

const ACTION_KEYS = ["nameInput.back", "nameInput.ok", "nameInput.cancel"] as const;
const POSE_KEY = ["idle", "walkL", "walkR"] as const;

/** Absolute rect in screen px -> a style with screen-px insets. */
function rect(style: HudRect): Record<string, number> {
  return { posType: 1, insetL: style.x0, insetT: style.y0, width: style.x1 - style.x0, height: style.y1 - style.y0 };
}

/** Absolute rect in screen px -> insets RELATIVE to a parent panel. */
function rel(style: HudRect, parent: HudRect): Record<string, number> {
  return {
    posType: 1,
    insetL: style.x0 - parent.x0,
    insetT: style.y0 - parent.y0,
    width: style.x1 - style.x0,
    height: style.y1 - style.y0,
  };
}

export function CreateCharScene(props: CreateCharSceneProps) {
  const st = (): NameInputState => props.state;
  const layout = (): CreateLayout => createLayout(props.width, props.height);
  const text = (): Record<string, string> =>
    withUiText(NAME_INPUT_UI_TEXT, undefined) as unknown as Record<string, string>;
  const grid = (): ReturnType<typeof createNameGrid> => createNameGrid(layout());
  const edit = (): HudRect => createEditBox(layout());
  const titleR = (): HudRect => createTitleRect(layout());

  const entryLabel = (index: number): string => {
    const state = st();
    if (index < state.charset.length) return nameInputCharAt(state, index);
    const key = ACTION_KEYS[index - state.charset.length];
    return key ? text()[key] ?? "" : "";
  };
  const entries = (): number[] => {
    const state = st();
    return Array.from({ length: state.charset.length + ACTION_KEYS.length }, (_, i) => i);
  };

  // The walker preview: an imperative image node (a CLUT8 tile through the
  // texture cache), re-pointed when the look, pose or facing changes. It
  // fills the preview box, which scales the 16 px walker up.
  const previewHost = createElement("view");
  setProp(previewHost, "style", { posType: 1, insetL: 0, insetT: 0, width: 64, height: 64 });
  const previewImg = createElement("image");
  setProp(previewImg, "style", { posType: 1, insetL: 0, insetT: 0, width: 64, height: 64 });
  insertNode(previewHost, previewImg);
  const lookCache = new TileTextureCache({ maxEntries: 16, maxBytes: 32 * 1024 });
  let tileRef: string | null = null;
  let tileIdx = -1;
  let lastBox = -1;

  const setFrame = (look: number, pose: number, facing: number): void => {
    const lk = WANDER_LOOKS[look]!;
    const idx = lk.frames[POSE_KEY[pose]!][facing]!;
    const ref = `${lk.tileset}#${idx}`;
    if (ref === tileRef) return;
    if (tileRef !== null) {
      getOps().setImage(previewImg.id, -1);
      lookCache.release(tileRef);
    }
    const handle = lookCache.acquire({ kind: "tile", ref, sourceWidth: 16, sourceHeight: 16 });
    getOps().setImage(previewImg.id, handle);
    tileRef = ref;
    tileIdx = idx;
  };

  // Walk in place (a 0..8..0 phase ping-pong) and rotate through the four
  // directions every ~0.8 s. The preview node is resized when the viewport
  // (and so the layout) changes.
  let frame = 0;
  onFrame(() => {
    frame++;
    const l = layout();
    const boxKey = (l.previewBox.x1 - l.previewBox.x0) | 0;
    if (boxKey !== lastBox) {
      lastBox = boxKey;
      setProp(previewHost, "style", { posType: 1, insetL: 0, insetT: 0, width: boxKey, height: boxKey });
      setProp(previewImg, "style", { posType: 1, insetL: 0, insetT: 0, width: boxKey, height: boxKey });
    }
    const phase = Math.floor(frame / 6) % 16;
    const pose = phase < 8 ? phase : 16 - phase;
    const facing = Math.floor(frame / 50) % 4;
    setFrame(props.look, walkPose(pose), facing);
  });

  const cellStyle = (index: number): Record<string, number | string> => {
    const g = grid();
    const state = st();
    const row = Math.floor(index / g.cols);
    const col = index % g.cols;
    const cursor = index === state.cursor;
    return {
      posType: 1,
      insetL: col * g.cellW,
      insetT: row * g.cellH,
      width: g.cellW,
      height: g.cellH,
      ...(cursor ? { bgColor: COLOURS.cursorBg } : {}),
    };
  };

  const baseName = (): string => LOOK_BASE_NAMES[Math.floor(props.look / LOOK_PALETTES)] ?? "";

  return (
    <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height }} debugName="online-create">
      {/* Name panel */}
      <View
        class="absolute"
        style={{
          posType: 1,
          ...rect(layout().namePanel),
          bgColor: COLOURS.panelBg,
          borderWidth: 2 * layout().s,
          borderColor: props.focus === "name" ? COLOURS.activeBorder : COLOURS.panelBorder,
        }}
        debugName="create-name"
      >
        <Text
          class="text-sm"
          style={{
            posType: 1,
            insetL: titleR().x0 - layout().namePanel.x0,
            insetT: titleR().y0 - layout().namePanel.y0,
            textColor: COLOURS.title,
            lineHeight: 18 * layout().s,
            height: 18 * layout().s,
          }}
        >
          {st().title}
        </Text>
        <View
          class="absolute"
          style={{
            posType: 1,
            ...rel(edit(), layout().namePanel),
            bgColor: COLOURS.editBg,
            borderWidth: layout().s,
            borderColor: COLOURS.editBorder,
          }}
          debugName="create-editbox"
        >
          <Text
            class="text-sm"
            style={{ posType: 1, insetL: 8 * layout().s, insetT: 4 * layout().s, textColor: COLOURS.buffer, lineHeight: 18 * layout().s, height: 18 * layout().s }}
          >
            {st().buffer}
          </Text>
          <Text
            class="text-sm"
            style={{
              posType: 1,
              insetL: 8 * layout().s + st().buffer.length * 16 * layout().s,
              insetT: 4 * layout().s,
              textColor: COLOURS.padding,
              lineHeight: 18 * layout().s,
              height: 18 * layout().s,
            }}
          >
            {"_".repeat(Math.max(0, st().maxLength - st().buffer.length))}
          </Text>
        </View>
        <View
          class="absolute"
          style={{ posType: 1, insetL: grid().x - layout().namePanel.x0, insetT: grid().y - layout().namePanel.y0 }}
          debugName="create-grid"
        >
          {entries().map((index) => (
            <View class="absolute items-center justify-center" style={cellStyle(index)} debugName={`create-cell-${index}`}>
              <Text
                class="text-sm"
                style={{
                  textColor: index === st().cursor ? COLOURS.cursorText : COLOURS.cell,
                  lineHeight: grid().cellH,
                  height: grid().cellH,
                }}
              >
                {entryLabel(index)}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* Preview panel */}
      <View
        class="absolute"
        style={{
          posType: 1,
          ...rect(layout().previewPanel),
          bgColor: COLOURS.panelBg,
          borderWidth: 2 * layout().s,
          borderColor: props.focus === "look" ? COLOURS.activeBorder : COLOURS.panelBorder,
        }}
        debugName="create-look"
      >
        <Text
          class="text-sm"
          style={{ posType: 1, insetL: 8 * layout().s, insetT: 8 * layout().s, textColor: COLOURS.title, lineHeight: 18 * layout().s, height: 18 * layout().s }}
        >
          LOOK
        </Text>
        <View
          class="absolute items-center justify-center"
          style={{ posType: 1, ...rel(layout().previewBox, layout().previewPanel), bgColor: COLOURS.previewBg, borderWidth: layout().s, borderColor: COLOURS.editBorder }}
          debugName="create-preview"
        >
          {previewHost as unknown as ReturnType<typeof View>}
        </View>
        <Text
          class="text-sm"
          style={{ posType: 1, ...rel(layout().counterRect, layout().previewPanel), textColor: COLOURS.label, lineHeight: 14 * layout().s, height: 14 * layout().s, textAlign: 1 }}
          debugName="create-counter"
        >
          {`${props.look + 1} / ${LOOK_COUNT}`}
        </Text>
        <Text
          class="text-xs"
          style={{ posType: 1, ...rel(layout().baseNameRect, layout().previewPanel), textColor: COLOURS.cell, lineHeight: 14 * layout().s, height: 14 * layout().s, textAlign: 1 }}
        >
          {`${baseName()} · ${(props.look % LOOK_PALETTES) + 1}`}
        </Text>
        <Text
          class="text-2xs"
          style={{ posType: 1, ...rel(layout().hintRect, layout().previewPanel), textColor: COLOURS.cell, lineHeight: 10 * layout().s, height: 30 * layout().s }}
        >
          {"L1/R1: FOCUS\nLEFT/RIGHT: PERSON\nUP/DOWN: COLOR"}
        </Text>
      </View>
    </View>
  );
}
