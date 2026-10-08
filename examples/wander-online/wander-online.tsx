// @title Pocket RPG Kit — Wander Online
// examples/wander-online/wander-online.tsx — a wander window shared by an
// authoritative server. The local player is predicted (inputs
// apply immediately through the same reducer the server runs) and
// reconciled against snapshots; remote players are interpolated 100 ms
// behind real time. See examples/wander-online/README.md.
import { mount } from "@pocketjs/framework";
import { OnlineView } from "./OnlineView.tsx";

mount(() => <OnlineView />);
