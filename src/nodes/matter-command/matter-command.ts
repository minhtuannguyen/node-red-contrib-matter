import type { MatterControllerNode } from "../matter-controller/matter-controller.js";
import type { NodeRedAPI, NodeRedDef, NodeRedMessage, NodeRedNode } from "../../types/node-red.js";

interface MatterCommandConfig extends NodeRedDef {
  controller: string;
  nodeId: string;
  endpointId: string;
  clusterId: string;
  commandName: string;
}

module.exports = function (RED: NodeRedAPI) {
  function MatterCommand(
    this: NodeRedNode,
    config: MatterCommandConfig,
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
      // Allow per-message overrides of every config field.
      const nodeId      = (msg["nodeId"]      as string | undefined) ?? config.nodeId;
      const endpointId  = parseInt((msg["endpointId"]  as string | undefined) ?? config.endpointId, 10);
      const clusterId   = parseInt((msg["clusterId"]   as string | undefined) ?? config.clusterId, 16);
      const commandName = (msg["commandName"] as string | undefined) ?? config.commandName;

      if (!nodeId || isNaN(endpointId) || isNaN(clusterId) || !commandName) {
        const err = new Error("matter-command: nodeId, endpointId, clusterId and commandName are all required.");
        this.status({ fill: "red", shape: "dot", text: "config missing" });
        done(err);
        return;
      }

      const args = (msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload))
        ? (msg.payload as Record<string, unknown>)
        : {};

      this.status({ fill: "yellow", shape: "dot", text: `invoking ${commandName}…` });

      try {
        const result = await controllerNode.manager.invokeCommand(
          nodeId, endpointId, clusterId, commandName, args,
        );
        this.status({ fill: "green", shape: "dot", text: `${commandName} ok` });
        send({ ...msg, payload: result ?? null, topic: commandName });
        done();
      } catch (err) {
        const e = err as Error;
        this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
        done(e);
      }
    });
  }

  RED.nodes.registerType(
    "matter-command",
    MatterCommand as unknown as new (...args: unknown[]) => void,
  );
};
