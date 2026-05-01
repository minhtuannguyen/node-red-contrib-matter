"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
module.exports = function (RED) {
    function MatterDecommission(config) {
        RED.nodes.createNode(this, config);
        const controllerNode = RED.nodes.getNode(config.controller);
        if (!controllerNode) {
            this.error("No Matter Controller config node selected.");
            this.status({ fill: "red", shape: "ring", text: "no controller" });
            return;
        }
        this.status({ fill: "grey", shape: "ring", text: "idle" });
        this.on("input", async (msg, send, done) => {
            const payload = msg.payload;
            const nodeId = (typeof payload?.["nodeId"] === "string" ? payload["nodeId"] : undefined)
                ?? config.nodeId;
            const force = typeof payload?.["force"] === "boolean" ? payload["force"] : Boolean(config.force);
            if (!nodeId) {
                const err = new Error("Node ID required: set msg.payload.nodeId or configure it in the node.");
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
                });
                done();
            }
            catch (err) {
                const e = err;
                this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
                done(e);
            }
        });
    }
    RED.nodes.registerType("matter-decommission", MatterDecommission);
};
//# sourceMappingURL=matter-decommission.js.map