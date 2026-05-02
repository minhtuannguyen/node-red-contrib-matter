"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
module.exports = function (RED) {
    function MatterSubscribe(config) {
        RED.nodes.createNode(this, config);
        const controllerNode = RED.nodes.getNode(config.controller);
        if (!controllerNode) {
            this.error("No Matter Controller config node selected.");
            this.status({ fill: "red", shape: "ring", text: "no controller" });
            return;
        }
        const nodeId = config.nodeId;
        if (!nodeId) {
            this.error("matter-subscribe: Node ID is required.");
            this.status({ fill: "red", shape: "ring", text: "no node ID" });
            return;
        }
        // Pre-parse optional filters
        const filterEndpoint = config.endpointId ? parseInt(config.endpointId, 10) : undefined;
        const filterCluster = config.clusterId ? parseInt(config.clusterId, 16) : undefined;
        const filterAttrName = config.attributeName || undefined;
        const filterEventName = config.eventName || undefined;
        // Use a stable reference so we can remove it on close
        const attrHandler = (event) => {
            if (filterEndpoint !== undefined && event.endpointId !== filterEndpoint)
                return;
            if (filterCluster !== undefined && event.clusterId !== filterCluster)
                return;
            if (filterAttrName !== undefined && event.attributeName !== filterAttrName)
                return;
            const msg = {
                payload: {
                    type: "attribute",
                    nodeId: event.nodeId,
                    endpointId: event.endpointId,
                    clusterId: event.clusterId,
                    attributeName: event.attributeName,
                    value: event.value,
                    timestamp: event.timestamp,
                },
                topic: event.attributeName,
            };
            this.send(msg);
        };
        const evtHandler = (event) => {
            if (filterEndpoint !== undefined && event.endpointId !== filterEndpoint)
                return;
            if (filterCluster !== undefined && event.clusterId !== filterCluster)
                return;
            if (filterEventName !== undefined && event.eventName !== filterEventName)
                return;
            const msg = {
                payload: {
                    type: "event",
                    nodeId: event.nodeId,
                    endpointId: event.endpointId,
                    clusterId: event.clusterId,
                    eventName: event.eventName,
                    events: event.events,
                    timestamp: event.timestamp,
                },
                topic: event.eventName,
            };
            this.send(msg);
        };
        // Register handlers — this also triggers connection + subscription lazily
        this.status({ fill: "yellow", shape: "dot", text: "connecting…" });
        controllerNode.manager
            .addAttributeHandler(nodeId, attrHandler)
            .then(() => controllerNode.manager.addEventHandler(nodeId, evtHandler))
            .then(() => {
            this.status({ fill: "green", shape: "dot", text: `subscribed — node ${nodeId}` });
        })
            .catch((err) => {
            this.status({ fill: "red", shape: "dot", text: err.message.slice(0, 40) });
            this.error(`matter-subscribe: failed to subscribe — ${err.message}`);
        });
        this.on("close", (_removed, done) => {
            controllerNode.manager.removeAttributeHandler(nodeId, attrHandler);
            controllerNode.manager.removeEventHandler(nodeId, evtHandler);
            done();
        });
    }
    RED.nodes.registerType("matter-subscribe", MatterSubscribe);
};
//# sourceMappingURL=matter-subscribe.js.map