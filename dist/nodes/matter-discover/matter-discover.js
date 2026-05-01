"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
module.exports = function (RED) {
    function MatterDiscover(config) {
        RED.nodes.createNode(this, config);
        const controllerNode = RED.nodes.getNode(config.controller);
        if (!controllerNode) {
            this.error("No Matter Controller config node selected.");
            this.status({ fill: "red", shape: "ring", text: "no controller" });
            return;
        }
        this.status({ fill: "grey", shape: "ring", text: "idle" });
        this.on("input", async (msg, send, done) => {
            const nodeId = msg["nodeId"] ?? config.nodeId;
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
                const clusterCount = description.endpoints.reduce((s, e) => s + e.clusters.length, 0);
                this.status({
                    fill: "green",
                    shape: "dot",
                    text: `${endpointCount} endpoints, ${clusterCount} clusters`,
                });
                send({ ...msg, payload: description, topic: `discover:${nodeId}` });
                done();
            }
            catch (err) {
                const e = err;
                this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
                done(e);
            }
        });
    }
    RED.nodes.registerType("matter-discover", MatterDiscover);
};
//# sourceMappingURL=matter-discover.js.map