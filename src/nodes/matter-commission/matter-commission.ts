import type { MatterControllerNode } from "../matter-controller/matter-controller.js";
import type { NodeRedAPI, NodeRedDef, NodeRedMessage, NodeRedNode } from "../../types/node-red.js";

interface MatterCommissionConfig extends NodeRedDef {
  controller: string;
  pairingCode: string;
  /** Optional friendly name stored in the device registry. Overridable via msg.payload.deviceName. */
  deviceName: string;
}

module.exports = function (RED: NodeRedAPI) {
  function MatterCommission(
    this: NodeRedNode,
    config: MatterCommissionConfig,
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
      const pairingCode =
        (msg.payload as Record<string, unknown>)?.["pairingCode"] as string | undefined
        ?? config.pairingCode;

      // Optional: pass msg.payload.knownAddress (IPv6/IPv4) to bypass mDNS discovery.
      // Useful for Thread devices whose commissioning mDNS isn't bridged to IP network.
      const knownAddress =
        (msg.payload as Record<string, unknown>)?.["knownAddress"] as string | undefined;

      // Optional friendly name for the device registry.
      // msg.payload.deviceName overrides the value configured in the node.
      const deviceName: string | undefined =
        ((msg.payload as Record<string, unknown>)?.["deviceName"] as string | undefined)
        ?? (config.deviceName || undefined);

      if (!pairingCode) {
        const err = new Error(
          'Pairing code required: set msg.payload.pairingCode or configure it in the node.',
        );
        this.status({ fill: "red", shape: "dot", text: "no pairing code" });
        done(err);
        return;
      }

      this.status({ fill: "yellow", shape: "dot", text: "commissioning…" });

      try {
        const nodeInfo = await controllerNode.manager.commission(pairingCode.replace(/-/g, ""), knownAddress, deviceName);
        this.status({ fill: "green", shape: "dot", text: `node ${nodeInfo.nodeId}` });
        const outMsg: NodeRedMessage = {
          ...msg,
          payload: nodeInfo,
          topic: "commissioned",
        };
        send(outMsg);
        done();
      } catch (err) {
        const e = err as Error;
        this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
        done(e);
      }
    });
  }

  RED.nodes.registerType(
    "matter-commission",
    MatterCommission as unknown as new (...args: unknown[]) => void,
  );
};
