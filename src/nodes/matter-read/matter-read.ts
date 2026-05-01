import type { MatterControllerNode } from "../matter-controller/matter-controller.js";
import type { NodeRedAPI, NodeRedDef, NodeRedMessage, NodeRedNode } from "../../types/node-red.js";

interface MatterReadConfig extends NodeRedDef {
  controller: string;
  nodeId: string;
  endpointId: string;
  clusterId: string;
  attributeName: string;
}

module.exports = function (RED: NodeRedAPI) {
  function MatterRead(
    this: NodeRedNode,
    config: MatterReadConfig,
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
      const nodeId        = (msg["nodeId"]        as string | undefined) ?? config.nodeId;
      const endpointId    = parseInt((msg["endpointId"]    as string | undefined) ?? config.endpointId, 10);
      const clusterId     = parseInt((msg["clusterId"]     as string | undefined) ?? config.clusterId, 16);
      const attributeName = (msg["attributeName"] as string | undefined) ?? config.attributeName;

      if (!nodeId || isNaN(endpointId) || isNaN(clusterId) || !attributeName) {
        const err = new Error("matter-read: nodeId, endpointId, clusterId and attributeName are all required.");
        this.status({ fill: "red", shape: "dot", text: "config missing" });
        done(err);
        return;
      }

      this.status({ fill: "yellow", shape: "dot", text: `reading ${attributeName}…` });

      try {
        const value = await controllerNode.manager.readAttribute(
          nodeId, endpointId, clusterId, attributeName,
        );
        this.status({ fill: "green", shape: "dot", text: `${attributeName}: ${JSON.stringify(value)}`.slice(0, 40) });
        send({ ...msg, payload: value, topic: attributeName });
        done();
      } catch (err) {
        const e = err as Error;
        this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
        done(e);
      }
    });
  }

  RED.nodes.registerType(
    "matter-read",
    MatterRead as unknown as new (...args: unknown[]) => void,
  );
};
