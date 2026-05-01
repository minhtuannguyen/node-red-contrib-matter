"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
module.exports = function (RED) {
    function MatterCommand(config) {
        RED.nodes.createNode(this, config);
        const controllerNode = RED.nodes.getNode(config.controller);
        if (!controllerNode) {
            this.error("No Matter Controller config node selected.");
            this.status({ fill: "red", shape: "ring", text: "no controller" });
            return;
        }
        this.status({ fill: "grey", shape: "ring", text: "idle" });
        this.on("input", async (msg, send, done) => {
            // Allow per-message overrides of every config field.
            const nodeId = msg["nodeId"] ?? config.nodeId;
            const endpointId = parseInt(msg["endpointId"] ?? config.endpointId, 10);
            const clusterId = parseInt(msg["clusterId"] ?? config.clusterId, 16);
            const commandName = msg["commandName"] ?? config.commandName;
            if (!nodeId || isNaN(endpointId) || isNaN(clusterId) || !commandName) {
                const err = new Error("matter-command: nodeId, endpointId, clusterId and commandName are all required.");
                this.status({ fill: "red", shape: "dot", text: "config missing" });
                done(err);
                return;
            }
            const args = (msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload))
                ? msg.payload
                : {};
            this.status({ fill: "yellow", shape: "dot", text: `invoking ${commandName}…` });
            try {
                const result = await controllerNode.manager.invokeCommand(nodeId, endpointId, clusterId, commandName, args);
                this.status({ fill: "green", shape: "dot", text: `${commandName} ok` });
                send({ ...msg, payload: result ?? null, topic: commandName });
                done();
            }
            catch (err) {
                const e = err;
                this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
                done(e);
            }
        });
    }
    RED.nodes.registerType("matter-command", MatterCommand);
};
//# sourceMappingURL=matter-command.js.map