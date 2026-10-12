// examples/wander-online/PostcardPanel.tsx — responsive presentation for the
// pure postcard controller. It intentionally shares the proven social-panel
// geometry so phone landscape stays between the floating controls.

import { Text, View } from "@pocketjs/framework/components";
import { createMemo, For } from "solid-js";
import {
  SOCIAL_PAGE_ROWS,
  SOCIAL_DETAIL_CELLS,
  fitSocialText,
  socialPanelLabelCells,
  type SocialRect,
  type SocialRowTone,
} from "./social-model.ts";
import {
  fitPostcardWideText,
  postcardMenuView,
  postcardPanelLayout,
  postcardPanelRowRect,
  type PostcardMenuData,
  type PostcardMenuState,
} from "./postcard-model.ts";

export interface PostcardPanelProps {
  state: PostcardMenuState;
  data: PostcardMenuData;
  width: number;
  height: number;
}

const COLOURS = {
  shade: "#07101d",
  panel: "#17243b",
  border: "#5d76a8",
  title: "#ffe17a",
  ink: "#e8efff",
  dim: "#8fa3c5",
  accent: "#9fd0ff",
  danger: "#ff9b9b",
  row: "#10192a",
  rowAlt: "#18243a",
  selected: "#354968",
  disabled: "#222b3b",
};

function relative(rect: SocialRect, parent: SocialRect): Record<string, number> {
  return {
    posType: 1,
    insetL: rect.x - parent.x,
    insetT: rect.y - parent.y,
    width: rect.w,
    height: rect.h,
  };
}

function textColour(tone: SocialRowTone): string {
  switch (tone) {
    case "accent": return COLOURS.accent;
    case "muted": return COLOURS.dim;
    case "danger": return COLOURS.danger;
    case "disabled": return COLOURS.dim;
    case "normal": return COLOURS.ink;
  }
}

export function PostcardPanel(props: PostcardPanelProps) {
  const layout = createMemo(() => postcardPanelLayout(props.width, props.height));
  const view = createMemo(() => postcardMenuView(props.state, props.data));
  return (
    <View
      class="absolute overflow-hidden"
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height }}
      debugName="postcard-panel-root"
    >
      <View
        class="absolute"
        style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height, bgColor: COLOURS.shade, opacity: 0.8 }}
        debugName="postcard-panel-shade"
      />
      <View
        class="absolute overflow-hidden"
        style={{
          posType: 1,
          insetL: layout().panel.x,
          insetT: layout().panel.y,
          width: layout().panel.w,
          height: layout().panel.h,
          bgColor: COLOURS.panel,
          borderWidth: 2 * layout().scale,
          borderColor: COLOURS.border,
        }}
        debugName="postcard-panel"
      >
        <Text
          class="absolute text-xs"
          style={{ ...relative(layout().header, layout().panel), textColor: COLOURS.title, lineHeight: 14 * layout().scale, height: 16 * layout().scale }}
          debugName="postcard-panel-title"
        >
          {fitSocialText(view().title, 48)}
        </Text>
        <For each={view().rows.slice(0, layout().rows)}>
          {(item, index) => {
            const bounds = createMemo(() => postcardPanelRowRect(layout(), index()));
            const selected = createMemo(() => view().page * SOCIAL_PAGE_ROWS + index() === view().state.cursor);
            return (
              <View
                class="absolute overflow-hidden"
                style={{
                  ...relative(bounds(), layout().panel),
                  bgColor: item.tone === "disabled" ? COLOURS.disabled
                    : selected() ? COLOURS.selected
                      : index() % 2 === 0 ? COLOURS.row : COLOURS.rowAlt,
                  borderWidth: selected() ? layout().scale : 0,
                  borderColor: selected() ? COLOURS.title : COLOURS.border,
                }}
                debugName={`postcard-row-${item.key}`}
              >
                <Text
                  class="absolute text-xs"
                  style={{
                    posType: 1,
                    insetL: 6 * layout().scale,
                    insetT: 5 * layout().scale,
                    width: Math.max(0, item.wide ? layout().body.w - 12 * layout().scale : layout().labelWidth - 6 * layout().scale),
                    height: 14 * layout().scale,
                    lineHeight: 14 * layout().scale,
                    textColor: textColour(item.tone),
                  }}
                >
                  {item.wide
                    ? fitPostcardWideText(item.label, layout())
                    : fitSocialText(item.label, socialPanelLabelCells(layout()))}
                </Text>
                <Text
                  class="absolute text-xs"
                  style={{
                    posType: 1,
                    insetL: layout().labelWidth + 8 * layout().scale,
                    insetT: 5 * layout().scale,
                    width: item.wide ? 0 : Math.max(0, layout().detailWidth - 8 * layout().scale),
                    height: 14 * layout().scale,
                    lineHeight: 14 * layout().scale,
                    textAlign: 2,
                    textColor: textColour(item.tone),
                  }}
                >
                  {item.wide ? "" : fitSocialText(item.detail, SOCIAL_DETAIL_CELLS)}
                </Text>
              </View>
            );
          }}
        </For>
        <Text
          class={props.data.locale === "zh" ? "absolute text-xs" : "absolute text-2xs"}
          style={{ ...relative(layout().footer, layout().panel), textColor: COLOURS.dim, lineHeight: 12 * layout().scale, height: 12 * layout().scale }}
          debugName="postcard-panel-footer"
        >
          {view().footer}
        </Text>
        <Text
          class="absolute text-2xs"
          style={{
            posType: 1,
            insetL: Math.max(0, layout().panel.w - 58 * layout().scale),
            insetT: Math.max(0, layout().panel.h - 22 * layout().scale),
            width: 46 * layout().scale,
            height: 12 * layout().scale,
            lineHeight: 12 * layout().scale,
            textAlign: 2,
            textColor: COLOURS.dim,
          }}
          debugName="postcard-panel-page"
        >
          {`${view().page + 1}/${view().pages}`}
        </Text>
      </View>
    </View>
  );
}
