import type { MatterControllerNode } from "../matter-controller/matter-controller.js";
import type { NodeRedAPI, NodeRedDef, NodeRedMessage, NodeRedNode } from "../../types/node-red.js";

interface MatterDecommissionConfig extends NodeRedDef {
  controller: string;
  /** Decimal node ID of the device to remove (can be overridden via msg.payload.nodeId) */
  nodeId: string;
  /**
   * When true, skip fabric-level decommissioning and erase local storage only.
   * Use when the device is offline / factory-reset already.
   * Can be overridden at runtime via msg.payload.force (boolean).
   */
  force: boolean;
}

module.exports = function (RED: NodeRedAPI) {
  function MatterDecommission(
    this: NodeRedNode,
    config: MatterDecommissionConfig,
  ) {
    RED.nodes.createNode(this, config);

    const controllerNode = RED.nodes.getNode(config.controller) as MatterControllerNode | null;

    if (!controllerNode) {
      this.error("No Matter Controller config node selected.");
      this.status({ fill: "red", shape: "ring", text: "no controller" });
      return;
    }

    this.status({ fill: "grey", shape: "ring", text: "idle" });

    this.on("input", async (msg: NodeRedMessage, send, done) => {
      const payload = msg.payload as Record<string, unknown> | null | undefined;

      const nodeId: string =
        (typeof payload?.["nodeId"] === "string" ? payload["nodeId"] : undefined)
        ?? config.nodeId;

      const force: boolean =
        typeof payload?.["force"] === "boolean" ? payload["force"] : Boolean(config.force);

      if (!nodeId) {
        const err = new Error(
          "Node ID required: set msg.payload.nodeId or configure it in the node.",
        );
        this.status({ fill: "red", shape: "dot", text: "no node ID" });
        done(err);
        return;
      }

      this.status({ fill: "yellow", shape: "dot", text: `removing ${nodeId}…` });

      try {
        await controllerNode.manager.removeDevice(nodeId, force);
        this.status({ fill: "green", shape: "dot", text: `removed ${nodeId}` });
        send({
          ...msg,
          payload: { ok: true, nodeId, force },
          topic: "decommissioned",
        } as NodeRedMessage);
        done();
      } catch (err) {
        const e = err as Error;
        this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
        done(e);
      }
    });
  }

  RED.nodes.registerType(
    "matter-decommission",
    MatterDecommission as unknown as new (...args: unknown[]) => void,
  );
};
