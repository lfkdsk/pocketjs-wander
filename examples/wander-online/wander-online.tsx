// @title Pocket RPG Kit — wander online (local multiplayer demo)
// examples/wander-online/wander-online.tsx — a frozen wander window shared
// by a local authoritative server. The local player is predicted (inputs
// apply immediately through the same reducer the server runs) and
// reconciled against snapshots; remote players are interpolated 100 ms
// behind real time. See examples/wander-online/README.md.
import { mount } from "@pocketjs/framework";
import { OnlineView } from "./OnlineView.tsx";

mount(() => <OnlineView />);
