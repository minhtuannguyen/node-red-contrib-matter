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
      if (!ctrl?.manager) {
        res.json({});
        return;
      }
      res.json(ctrl.manager.getRegistry());
    },
  );

  RED.httpAdmin.post(
    "/matter-nodes/:id/rediscover",
    (req, res) => {
      const ctrl = RED.nodes.getNode(req.params["id"]) as MatterControllerNode | null;
      if (!ctrl?.manager) {
        res.status(404).json({ error: "Controller not found or not started" });
        return;
      }
      ctrl.manager.rediscoverAll()
        .then(() => res.json({ ok: true }))
        .catch((e: Error) => res.status(500).json({ error: e.message }));
    },
  );

  RED.httpAdmin.get(
    "/matter-nodes/:id/registry/:nodeId/signal",
    (req, res) => {
      const ctrl = RED.nodes.getNode(req.params["id"]) as MatterControllerNode | null;
      if (!ctrl?.manager) {
        res.status(404).json({ error: "Controller not found or not started" });
        return;
      }
      ctrl.manager.readSignalStrength(req.params["nodeId"])
        .then((info) => res.json(info))
        .catch((e: Error) => res.status(500).json({ error: e.message }));
    },
  );

  RED.httpAdmin.post(
    "/matter-nodes/:id/registry/:nodeId/rename",
    (req, res) => {
      const ctrl = RED.nodes.getNode(req.params["id"]) as MatterControllerNode | null;
      if (!ctrl?.manager) {
        res.status(404).json({ error: "Controller not found or not started" });
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const label = ((req as any).body as { label?: string } | undefined)?.label ?? "";
      if (!label.trim()) {
        res.status(400).json({ error: "label is required" });
        return;
      }
      try {
        ctrl.manager.renameDevice(req.params["nodeId"], label);
        res.json({ ok: true });
      } catch (e) {
        res.status(404).json({ error: (e as Error).message });
      }
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
