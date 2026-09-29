// @title Pocket RPG Kit — an endless world that grows as you walk
// examples/wander/wander.tsx — an unbounded, procedurally grown 2D world
// that streams chunks in and out around a focus point. Towns grow when
// they first come near, roads meet at hashed region gates, and an
// auto-wander driver walks the world by itself until a button takes over.
import { mount } from "@pocketjs/framework";
import { WanderView } from "./WanderView.tsx";

mount(() => <WanderView />);
