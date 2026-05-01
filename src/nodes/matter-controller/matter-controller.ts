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
  // HTTP admin endpoint — serves the device registry so node edit UIs can
  // populate cascading dropdowns without manual copy-paste of IDs.
  // No extra auth guard needed: the route is on httpAdmin (admin-only port)
  // and returns only read-only device metadata.
  RED.httpAdmin.get(
    "/matter-nodes/:id/registry",
    (req, res) => {
      const ctrl = RED.nodes.getNode(req.params["id"]) as MatterControllerNode | null;
      // Return empty registry (200) when the controller node isn't in the
      // runtime yet (e.g. flow not deployed). The UI will show an empty
      // device list rather than an error, which is less confusing.
      if (!ctrl?.manager) {
        res.json({});
        return;
      }
      res.json(ctrl.manager.getRegistry());
    },
  );

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
