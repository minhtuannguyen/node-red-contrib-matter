import { ControllerManager } from "../../lib/controller-manager.js";
import type { NodeRedAPI, NodeRedDef, NodeRedNode } from "../../types/node-red.js";

export interface MatterControllerConfig extends NodeRedDef {
  storagePath: string;
  port: string;
  logLevel: string;
}

/** Extended Node-RED node that exposes the ControllerManager to sibling nodes. */
export interface MatterControllerNode extends NodeRedNode {
  manager: ControllerManager;
}

module.exports = function (RED: NodeRedAPI) {
  function MatterController(
    this: MatterControllerNode,
    config: MatterControllerConfig,
  ) {
    RED.nodes.createNode(this, config);

    const storagePath = config.storagePath || `${process.env["HOME"]}/.node-red-matter`;
    const port = parseInt(config.port, 10) || 5540;

    this.manager = ControllerManager.getInstance(storagePath, port);

    this.manager.start().then(() => {
      this.log(`Matter controller ready — storage: ${storagePath}`);
    }).catch((err: Error) => {
      this.error(`Failed to start Matter controller: ${err.message}`);
    });

    this.on("close", (_removed: boolean, done: () => void) => {
      this.manager.close().finally(done);
    });
  }

  RED.nodes.registerType("matter-controller", MatterController as unknown as new (...args: unknown[]) => void);
};
