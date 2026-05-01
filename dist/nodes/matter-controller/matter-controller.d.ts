import { ControllerManager } from "../../lib/controller-manager.js";
import type { NodeRedDef, NodeRedNode } from "../../types/node-red.js";
export interface MatterControllerConfig extends NodeRedDef {
    storagePath: string;
    port: string;
    logLevel: string;
}
/** Extended Node-RED node that exposes the ControllerManager to sibling nodes. */
export interface MatterControllerNode extends NodeRedNode {
    manager: ControllerManager;
}
//# sourceMappingURL=matter-controller.d.ts.map