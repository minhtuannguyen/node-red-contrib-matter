import type { MatterControllerNode } from "../matter-controller/matter-controller.js";
import type {
  AttributeChangedEvent,
  AttributeChangeHandler,
  EventTriggeredEvent,
  EventTriggeredHandler,
} from "../../lib/controller-manager.js";
import type { NodeRedAPI, NodeRedDef, NodeRedMessage, NodeRedNode } from "../../types/node-red.js";

interface MatterSubscribeConfig extends NodeRedDef {
  controller: string;
  nodeId: string;
  /** Optional — if set, only emit when endpointId matches */
  endpointId: string;
  /** Optional — hex cluster ID filter */
  clusterId: string;
  /** Optional — attribute name filter */
  attributeName: string;
  /** Optional — event name filter */
  eventName: string;
  /** When true, emit cached attribute values immediately after subscribing */
  readInitialState: boolean;
}

module.exports = function (RED: NodeRedAPI) {
  function MatterSubscribe(
    this: NodeRedNode,
    config: MatterSubscribeConfig,
  ) {
    RED.nodes.createNode(this, config);

    const controllerNode = RED.nodes.getNode(config.controller) as MatterControllerNode | null;

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
    const filterEndpoint  = config.endpointId  ? parseInt(config.endpointId, 10)  : undefined;
    const filterCluster   = config.clusterId   ? parseInt(config.clusterId, 16)   : undefined;
    const filterAttrName  = config.attributeName  || undefined;
    const filterEventName = config.eventName      || undefined;

    // Use a stable reference so we can remove it on close
    const attrHandler: AttributeChangeHandler = (event: AttributeChangedEvent) => {
      if (filterEndpoint  !== undefined && event.endpointId  !== filterEndpoint)  return;
      if (filterCluster   !== undefined && event.clusterId   !== filterCluster)   return;
      if (filterAttrName  !== undefined && event.attributeName !== filterAttrName) return;

      const msg: NodeRedMessage = {
        payload: {
          type:          "attribute",
          nodeId:        event.nodeId,
          endpointId:    event.endpointId,
          clusterId:     event.clusterId,
          attributeName: event.attributeName,
          value:         event.value,
          timestamp:     event.timestamp,
        },
        topic: event.attributeName,
      };
      this.send(msg);
    };

    const evtHandler: EventTriggeredHandler = (event: EventTriggeredEvent) => {
      if (filterEndpoint  !== undefined && event.endpointId !== filterEndpoint) return;
      if (filterCluster   !== undefined && event.clusterId  !== filterCluster)  return;
      if (filterEventName !== undefined && event.eventName  !== filterEventName) return;

      const msg: NodeRedMessage = {
        payload: {
          type:      "event",
          nodeId:    event.nodeId,
          endpointId: event.endpointId,
          clusterId: event.clusterId,
          eventName: event.eventName,
          events:    event.events,
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
      .then(async () => {
        this.status({ fill: "green", shape: "dot", text: `subscribed — node ${nodeId}` });

        if (!config.readInitialState) return;

        const registry = controllerNode.manager.getRegistry();
        const entry = registry[nodeId];
        const endpoints = entry?.discovery?.endpoints ?? [];
        const now = new Date().toISOString();

        for (const ep of endpoints) {
          if (filterEndpoint !== undefined && ep.endpointId !== filterEndpoint) continue;
          for (const cl of ep.clusters) {
            if (filterCluster !== undefined && cl.clusterId !== filterCluster) continue;
            for (const attrName of cl.attributes) {
              if (filterAttrName !== undefined && attrName !== filterAttrName) continue;
              try {
                const value = await controllerNode.manager.readCachedAttribute(
                  nodeId, ep.endpointId, cl.clusterId, attrName,
                );
                this.send({
                  payload: {
                    type:          "attribute",
                    nodeId,
                    endpointId:    ep.endpointId,
                    clusterId:     cl.clusterId,
                    attributeName: attrName,
                    value,
                    timestamp:     now,
                  },
                  topic: attrName,
                } as NodeRedMessage);
              } catch {
                // attribute not yet in local cache — skip silently
              }
            }
          }
        }
      })
      .catch((err: Error) => {
        this.status({ fill: "red", shape: "dot", text: err.message.slice(0, 40) });
        this.error(`matter-subscribe: failed to subscribe — ${err.message}`);
      });

    this.on("close", (_removed: boolean, done: () => void) => {
      controllerNode.manager.removeAttributeHandler(nodeId, attrHandler);
      controllerNode.manager.removeEventHandler(nodeId, evtHandler);
      done();
    });
  }

  RED.nodes.registerType(
    "matter-subscribe",
    MatterSubscribe as unknown as new (...args: unknown[]) => void,
  );
};
