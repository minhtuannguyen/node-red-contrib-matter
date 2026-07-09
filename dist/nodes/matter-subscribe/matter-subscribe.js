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
        const filterOperator = config.filterOperator || '';
        const filterValue = config.filterValue ?? '';
        // Pre-coerce filterValue: boolean → string → number priority
        const filterValueCoerced = filterValue === 'true' ? true :
            filterValue === 'false' ? false :
                (filterValue !== '' && !isNaN(Number(filterValue))) ? Number(filterValue) :
                    filterValue;
        const matchesValueFilter = (raw) => {
            if (!filterOperator || filterValue === '')
                return true;
            // Coerce the incoming value the same way
            const av = typeof raw === 'boolean' ? raw :
                typeof raw === 'number' ? raw :
                    (raw !== null && raw !== undefined && !isNaN(Number(raw)) ? Number(raw) : raw);
            switch (filterOperator) {
                case '==': return av === filterValueCoerced;
                case '!=': return av !== filterValueCoerced;
                case '<': return av < filterValueCoerced;
                case '<=': return av <= filterValueCoerced;
                case '>': return av > filterValueCoerced;
                case '>=': return av >= filterValueCoerced;
                default: return true;
            }
        };
        // Use a stable reference so we can remove it on close
        const attrHandler = (event) => {
            if (filterEndpoint !== undefined && event.endpointId !== filterEndpoint)
                return;
            if (filterCluster !== undefined && event.clusterId !== filterCluster)
                return;
            if (filterAttrName !== undefined && event.attributeName !== filterAttrName)
                return;
            if (!matchesValueFilter(event.value))
                return;
            const msg = {
                payload: {
                    type: "attribute",
                    nodeId: event.nodeId,
                    endpointId: event.endpointId,
                    clusterId: event.clusterId,
                    clusterName: event.clusterName,
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
                    clusterName: event.clusterName,
                    eventName: event.eventName,
                    events: event.events,
                    timestamp: event.timestamp,
                },
                topic: event.eventName,
            };
            this.send(msg);
        };
        // Tracks whether this node instance has been closed (redeploy/restart)
        // while an add*Handler()/readInitialState chain is still in flight, so we
        // never register a handler — or call this.send() — after the point of no
        // return: `close` only fires once, so anything registered afterwards
        // would otherwise be a permanent zombie handler inside
        // controllerNode.manager.
        let closed = false;
        // Register handlers — this also triggers connection + subscription lazily
        this.status({ fill: "yellow", shape: "dot", text: "connecting…" });
        // Build subscription filters from the node's config. When a clusterId is
        // set, the controller uses selective per-cluster subscription instead of
        // subscribing to every attribute on the device, which saves significant RAM.
        const attrFilter = filterCluster !== undefined
            ? { endpointId: filterEndpoint, clusterId: filterCluster, attributeName: filterAttrName }
            : undefined;
        const evtFilter = filterCluster !== undefined
            ? { endpointId: filterEndpoint, clusterId: filterCluster, eventName: filterEventName }
            : undefined;
        controllerNode.manager
            .addAttributeHandler(nodeId, attrHandler, attrFilter)
            .then(() => {
            if (closed) {
                // Node closed while addAttributeHandler() was in flight. attrHandler
                // was already registered synchronously before the await inside it,
                // so the close handler's removeAttributeHandler() call already
                // cleaned it up — just stop here instead of registering evtHandler
                // for a node instance that no longer exists.
                return;
            }
            return controllerNode.manager.addEventHandler(nodeId, evtHandler, evtFilter);
        })
            .then(async () => {
            if (closed) {
                // Node closed while addEventHandler() was in flight — evtHandler
                // was just registered above (after close already fired, so it will
                // never be removed otherwise). Undo it now to avoid a zombie handler.
                controllerNode.manager.removeEventHandler(nodeId, evtHandler);
                return;
            }
            this.status({ fill: "green", shape: "dot", text: `subscribed — node ${nodeId}` });
            if (!config.readInitialState)
                return;
            const registry = controllerNode.manager.getRegistry();
            const entry = registry[nodeId];
            const endpoints = entry?.discovery?.endpoints ?? [];
            const now = new Date().toISOString();
            for (const ep of endpoints) {
                if (closed)
                    return;
                if (filterEndpoint !== undefined && ep.endpointId !== filterEndpoint)
                    continue;
                for (const cl of ep.clusters) {
                    if (closed)
                        return;
                    if (filterCluster !== undefined && cl.clusterId !== filterCluster)
                        continue;
                    for (const attrName of cl.attributes) {
                        if (closed)
                            return;
                        if (filterAttrName !== undefined && attrName !== filterAttrName)
                            continue;
                        try {
                            const value = await controllerNode.manager.readCachedAttribute(nodeId, ep.endpointId, cl.clusterId, attrName);
                            if (closed)
                                return;
                            this.send({
                                payload: {
                                    type: "attribute",
                                    nodeId,
                                    endpointId: ep.endpointId,
                                    clusterId: cl.clusterId,
                                    clusterName: cl.clusterName,
                                    attributeName: attrName,
                                    value,
                                    timestamp: now,
                                },
                                topic: attrName,
                            });
                        }
                        catch {
                            // attribute not yet in local cache — skip silently
                        }
                    }
                }
            }
        })
            .catch((err) => {
            if (closed)
                return;
            this.status({ fill: "red", shape: "dot", text: err.message.slice(0, 40) });
            this.error(`matter-subscribe: failed to subscribe — ${err.message}`);
        });
        this.on("close", (_removed, done) => {
            closed = true;
            controllerNode.manager.removeAttributeHandler(nodeId, attrHandler);
            controllerNode.manager.removeEventHandler(nodeId, evtHandler);
            done();
        });
    }
    RED.nodes.registerType("matter-subscribe", MatterSubscribe);
};
//# sourceMappingURL=matter-subscribe.js.map