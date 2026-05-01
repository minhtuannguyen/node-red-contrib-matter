import type { MatterControllerNode } from "../matter-controller/matter-controller.js";
import type { NodeRedAPI, NodeRedDef, NodeRedMessage, NodeRedNode } from "../../types/node-red.js";

interface MatterDiscoverConfig extends NodeRedDef {
  controller: string;
  nodeId: string;
}

module.exports = function (RED: NodeRedAPI) {
  function MatterDiscover(
    this: NodeRedNode,
    config: MatterDiscoverConfig,
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
      const nodeId = (msg["nodeId"] as string | undefined) ?? config.nodeId;

      if (!nodeId) {
        const err = new Error("matter-discover: nodeId is required (config or msg.nodeId).");
        this.status({ fill: "red", shape: "dot", text: "no nodeId" });
        done(err);
        return;
      }

      this.status({ fill: "yellow", shape: "dot", text: `discovering node ${nodeId}…` });

      try {
        const description = await controllerNode.manager.discoverDevice(nodeId);
        const endpointCount = description.endpoints.length;
        const clusterCount  = description.endpoints.reduce((s, e) => s + e.clusters.length, 0);
        this.status({
          fill: "green",
          shape: "dot",
          text: `${endpointCount} endpoints, ${clusterCount} clusters`,
        });
        send({ ...msg, payload: description, topic: `discover:${nodeId}` });
        done();
      } catch (err) {
        const e = err as Error;
        this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
        done(e);
      }
    });
  }

  RED.nodes.registerType(
    "matter-discover",
    MatterDiscover as unknown as new (...args: unknown[]) => void,
  );
};
