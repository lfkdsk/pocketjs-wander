// examples/wander-online/PlayerLookPreview.tsx — a tiny animated W-CHAR
// portrait shared by low-frequency account surfaces such as player cards.

import { View } from "@pocketjs/framework/components";
import { createElement, insertNode, setProp } from "@pocketjs/framework/renderer";
import { getOps } from "@pocketjs/framework/host";
import { onCleanup, onFrame } from "@pocketjs/framework/lifecycle";
import { TileTextureCache } from "../../vendor/pocket-rpgkit/src/ui/tile-texture-cache.ts";
import { walkPose } from "../../vendor/pocket-rpgkit/src/engine/movement.ts";
import { WANDER_LOOKS } from "../wander/assets-wander.ts";

export interface PlayerLookPreviewProps {
  look: number;
  size: number;
}

const POSE_KEY = ["idle", "walkL", "walkR"] as const;

export function PlayerLookPreview(props: PlayerLookPreviewProps) {
  const host = createElement("view");
  const image = createElement("image");
  insertNode(host, image);
  const cache = new TileTextureCache({ maxEntries: 8, maxBytes: 16 * 1024 });
  let tileRef: string | null = null;
  let lastSize = -1;
  let frame = 0;

  const detach = (): void => {
    if (tileRef === null) return;
    getOps().setImage(image.id, -1);
    cache.release(tileRef);
    tileRef = null;
  };

  onFrame(() => {
    const size = Math.max(1, Math.floor(props.size));
    if (size !== lastSize) {
      lastSize = size;
      const style = { posType: 1, insetL: 0, insetT: 0, width: size, height: size };
      setProp(host, "style", style);
      setProp(image, "style", style);
    }
    const look = Math.max(0, Math.min(WANDER_LOOKS.length - 1, Math.floor(props.look)));
    const phase = Math.floor(frame++ / 8) % 16;
    const pose = phase < 8 ? phase : 16 - phase;
    const definition = WANDER_LOOKS[look]!;
    const tile = definition.frames[POSE_KEY[walkPose(pose)]!][0]!;
    const ref = `${definition.tileset}#${tile}`;
    if (ref === tileRef) return;
    detach();
    getOps().setImage(image.id, cache.acquire({ kind: "tile", ref, sourceWidth: 16, sourceHeight: 16 }));
    tileRef = ref;
  });

  onCleanup(() => {
    detach();
    cache.clear();
  });

  return host as unknown as ReturnType<typeof View>;
}
