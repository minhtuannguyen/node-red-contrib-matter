"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// ---------------------------------------------------------------------------
// Module-level constants — allocated once, never reallocated
// ---------------------------------------------------------------------------
/** Matter cluster ID for TimeSynchronization (spec §11.17). */
const TIME_SYNC_CLUSTER_ID = 0x0038;
/**
 * TimeSynchronization shall only be present on the root endpoint (endpoint 0).
 * Matter spec §11.17: "shall NOT be present on any other Endpoint of any Node."
 */
const ROOT_ENDPOINT = 0;
/**
 * GranularityEnum.MillisecondsGranularity = 3.
 * Date.now() provides millisecond-resolution; advertising milliseconds is honest
 * and maximally useful to the device for drift estimation.
 */
const GRANULARITY_MILLISECONDS = 3;
/**
 * TimeSourceEnum.Admin = 2.
 * We are an authoritative administrator pushing time rather than passively
 * syncing from an NTP/SNTP source.
 */
const TIME_SOURCE_ADMIN = 2;
/**
 * Microseconds between Unix epoch (1970-01-01 UTC) and Matter epoch (2000-01-01 UTC).
 * 30 years with 7 leap years (1972, 1976, 1980, 1984, 1988, 1992, 1996):
 *   (30 × 365 + 7) × 86400 × 1_000_000 = 946_684_800_000_000 µs
 * Cross-checked: new Date('2000-01-01T00:00:00Z').getTime() × 1000 === this value.
 * Stored as a BigInt literal — zero runtime cost, no allocation on each call.
 */
const MATTER_EPOCH_OFFSET_US = 946684800000000n;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Returns current wall-clock time expressed as Matter epoch-us
 * (microseconds since 2000-01-01 00:00:00 UTC).
 *
 * Uses a single Date.now() call — no Date object heap-allocated.
 * BigInt arithmetic is used for the 64-bit range required by the spec.
 */
function nowMatterEpochUs() {
    return BigInt(Date.now()) * 1000n - MATTER_EPOCH_OFFSET_US;
}
module.exports = function (RED) {
    function MatterTimeSync(config) {
        RED.nodes.createNode(this, config);
        const controllerNode = RED.nodes.getNode(config.controller);
        if (!controllerNode) {
            this.error("No Matter Controller config node selected.");
            this.status({ fill: "red", shape: "ring", text: "no controller" });
            return;
        }
        this.status({ fill: "grey", shape: "ring", text: "idle" });
        this.on("input", async (msg, send, done) => {
            // Allow per-message nodeId override; fall back to the configured value.
            const nodeId = msg["nodeId"] ?? config.nodeId;
            if (!nodeId) {
                const err = new Error("matter-time-sync: nodeId is required (configure the node or set msg.nodeId).");
                this.status({ fill: "red", shape: "dot", text: "nodeId missing" });
                done(err);
                return;
            }
            this.status({ fill: "yellow", shape: "dot", text: "syncing…" });
            try {
                // Capture time as close to the network call as possible to minimise
                // the offset introduced by Node-RED event-loop scheduling.
                const utcTime = nowMatterEpochUs();
                await controllerNode.manager.invokeCommand(nodeId, ROOT_ENDPOINT, TIME_SYNC_CLUSTER_ID, "setUtcTime", 
                // utcTime is a BigInt — valid as Record<string,unknown> value;
                // matter.js TLV encoder reads the runtime type and encodes correctly.
                { utcTime, granularity: GRANULARITY_MILLISECONDS, timeSource: TIME_SOURCE_ADMIN });
                // ISO timestamp for the output message — one allocation on success only.
                const syncedAt = new Date().toISOString();
                this.status({ fill: "green", shape: "dot", text: `synced ${syncedAt.slice(11, 19)} UTC` });
                send({ ...msg, payload: { synced: true, syncedAt }, topic: "time-sync" });
                done();
            }
            catch (err) {
                const e = err;
                this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
                done(e);
            }
        });
    }
    RED.nodes.registerType("matter-time-sync", MatterTimeSync);
};
//# sourceMappingURL=matter-time-sync.js.map