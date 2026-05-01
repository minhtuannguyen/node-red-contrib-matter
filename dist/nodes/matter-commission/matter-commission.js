"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
module.exports = function (RED) {
    function MatterCommission(config) {
        RED.nodes.createNode(this, config);
        const controllerNode = RED.nodes.getNode(config.controller);
        if (!controllerNode) {
            this.error("No Matter Controller config node selected.");
            this.status({ fill: "red", shape: "ring", text: "no controller" });
            return;
        }
        this.status({ fill: "grey", shape: "ring", text: "idle" });
        this.on("input", async (msg, send, done) => {
            const pairingCode = msg.payload?.["pairingCode"]
                ?? config.pairingCode;
            // Optional: pass msg.payload.knownAddress (IPv6/IPv4) to bypass mDNS discovery.
            // Useful for Thread devices whose commissioning mDNS isn't bridged to IP network.
            const knownAddress = msg.payload?.["knownAddress"];
            if (!pairingCode) {
                const err = new Error('Pairing code required: set msg.payload.pairingCode or configure it in the node.');
                this.status({ fill: "red", shape: "dot", text: "no pairing code" });
                done(err);
                return;
            }
            this.status({ fill: "yellow", shape: "dot", text: "commissioning…" });
            try {
                const nodeInfo = await controllerNode.manager.commission(pairingCode.replace(/-/g, ""), knownAddress);
                this.status({ fill: "green", shape: "dot", text: `node ${nodeInfo.nodeId}` });
                const outMsg = {
                    ...msg,
                    payload: nodeInfo,
                    topic: "commissioned",
                };
                send(outMsg);
                done();
            }
            catch (err) {
                const e = err;
                this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
                done(e);
            }
        });
    }
    RED.nodes.registerType("matter-commission", MatterCommission);
};
//# sourceMappingURL=matter-commission.js.map