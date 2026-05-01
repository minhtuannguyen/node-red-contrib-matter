"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
module.exports = function (RED) {
    function MatterRead(config) {
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
            const endpointId = parseInt(msg["endpointId"] ?? config.endpointId, 10);
            const clusterId = parseInt(msg["clusterId"] ?? config.clusterId, 16);
            const attributeName = msg["attributeName"] ?? config.attributeName;
            if (!nodeId || isNaN(endpointId) || isNaN(clusterId) || !attributeName) {
                const err = new Error("matter-read: nodeId, endpointId, clusterId and attributeName are all required.");
                this.status({ fill: "red", shape: "dot", text: "config missing" });
                done(err);
                return;
            }
            this.status({ fill: "yellow", shape: "dot", text: `reading ${attributeName}…` });
            try {
                const value = await controllerNode.manager.readAttribute(nodeId, endpointId, clusterId, attributeName);
                this.status({ fill: "green", shape: "dot", text: `${attributeName}: ${JSON.stringify(value)}`.slice(0, 40) });
                send({ ...msg, payload: value, topic: attributeName });
                done();
            }
            catch (err) {
                const e = err;
                this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
                done(e);
            }
        });
    }
    RED.nodes.registerType("matter-read", MatterRead);
};
//# sourceMappingURL=matter-read.js.map