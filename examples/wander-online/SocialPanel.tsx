// examples/wander-online/SocialPanel.tsx — bounded presentation for the pure
// social-model controller. The parent owns input edges, data and side effects.

import { Text, View } from "@pocketjs/framework/components";
import { createMemo, For } from "solid-js";
import {
  SOCIAL_DETAIL_CELLS,
  SOCIAL_PAGE_ROWS,
  fitSocialText,
  socialPanelLabelCells,
  socialPanelLayout,
  socialPanelRowRect,
  socialMenuView,
  type SocialMenuData,
  type SocialMenuState,
  type SocialPanelLayout,
  type SocialRect,
  type SocialRowTone,
} from "./social-model.ts";

export { socialPanelLayout, socialPanelRowRect } from "./social-model.ts";
export type { SocialPanelLayout, SocialRect } from "./social-model.ts";

export interface SocialPanelProps {
  state: SocialMenuState;
  data: SocialMenuData;
  width: number;
  height: number;
}

const COLOURS = {
  shade: "#07101d",
  panel: "#141c30",
  border: "#4a5f8f",
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

export function SocialPanel(props: SocialPanelProps) {
  const layout = createMemo(() => socialPanelLayout(props.width, props.height));
  const view = createMemo(() => socialMenuView(props.state, props.data));
  const heading = createMemo(() => {
    const realm = props.data.currentRealm;
    return fitSocialText(realm ? `${view().title} · ${realm}` : view().title, 48);
  });

  return (
    <View
      class="absolute overflow-hidden"
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height }}
      debugName="social-panel-root"
    >
      <View
        class="absolute"
        style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height, bgColor: COLOURS.shade, opacity: 0.8 }}
        debugName="social-panel-shade"
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
        debugName="social-panel"
      >
        <Text
          class="absolute text-sm"
          style={{
            ...relative(layout().header, layout().panel),
            textColor: COLOURS.title,
            lineHeight: 18 * layout().scale,
            height: 18 * layout().scale,
          }}
          debugName="social-panel-title"
        >
          {heading()}
        </Text>

        <For each={view().rows.slice(0, layout().rows)}>
          {(item, index) => {
            const rect = createMemo(() => socialPanelRowRect(layout(), index()));
            const selected = createMemo(() => view().page * SOCIAL_PAGE_ROWS + index() === view().state.cursor);
            return (
              <View
                class="absolute overflow-hidden"
                style={{
                  ...relative(rect(), layout().panel),
                  bgColor: item.tone === "disabled"
                    ? COLOURS.disabled
                    : selected()
                      ? COLOURS.selected
                      : index() % 2 === 0 ? COLOURS.row : COLOURS.rowAlt,
                  borderWidth: selected() ? layout().scale : 0,
                  borderColor: selected() ? COLOURS.title : COLOURS.border,
                }}
                debugName={`social-row-${item.key}`}
              >
                <Text
                  class="absolute text-xs"
                  style={{
                    posType: 1,
                    insetL: 6 * layout().scale,
                    insetT: 5 * layout().scale,
                    width: Math.max(0, layout().labelWidth - 6 * layout().scale),
                    height: 14 * layout().scale,
                    lineHeight: 14 * layout().scale,
                    textColor: textColour(item.tone),
                  }}
                >
                  {fitSocialText(item.label, socialPanelLabelCells(layout()))}
                </Text>
                <Text
                  class="absolute text-xs"
                  style={{
                    posType: 1,
                    insetL: layout().labelWidth + 8 * layout().scale,
                    insetT: 5 * layout().scale,
                    width: Math.max(0, layout().detailWidth - 8 * layout().scale),
                    height: 14 * layout().scale,
                    lineHeight: 14 * layout().scale,
                    textAlign: 2,
                    textColor: textColour(item.tone),
                  }}
                >
                  {fitSocialText(item.detail, SOCIAL_DETAIL_CELLS)}
                </Text>
              </View>
            );
          }}
        </For>

        <Text
          class="absolute text-2xs"
          style={{
            ...relative(layout().footer, layout().panel),
            textColor: COLOURS.dim,
            lineHeight: 12 * layout().scale,
            height: 12 * layout().scale,
          }}
          debugName="social-panel-footer"
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
          debugName="social-panel-page"
        >
          {`${view().page + 1}/${view().pages}`}
        </Text>
      </View>
    </View>
  );
}
