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
 * GranularityEnum.MicrosecondsGranularity = 4.
 * Matches what the Home Assistant Matter Time Sync integration uses, and is
 * the highest granularity the host system clock can honestly claim.
 */
const GRANULARITY_MICROSECONDS = 4;
/**
 * TimeSourceEnum.Admin = 2.
 * We are an authoritative administrator pushing time.
 */
const TIME_SOURCE_ADMIN = 2;
/**
 * Unix epoch-microseconds corresponding to Matter epoch start (2000-01-01 00:00:00 UTC).
 *
 * matter.js's TlvEpochUs wrapper expects Unix epoch µs and subtracts this
 * offset internally before encoding on the wire.  When a TimeZone entry must
 * have validAt = 0 (= "valid from Matter epoch 0"), pass THIS constant so
 * TlvEpochUs computes: 946_684_800_000_000 − 946_684_800_000_000 = 0.
 *
 * Cross-check: new Date('2000-01-01T00:00:00Z').getTime() * 1_000 === this value.
 */
const MATTER_EPOCH_START_UNIX_US = 946684800000000n;
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
            const nodeId = msg["nodeId"] ?? config.nodeId;
            if (!nodeId) {
                const err = new Error("matter-time-sync: nodeId is required (configure the node or set msg.nodeId).");
                this.status({ fill: "red", shape: "dot", text: "nodeId missing" });
                done(err);
                return;
            }
            this.status({ fill: "yellow", shape: "dot", text: "syncing…" });
            try {
                // Capture wall-clock once — both UTC time and timezone offset come
                // from the same Date object, avoiding two separate system calls.
                const now = new Date();
                // getTimezoneOffset() = minutes WEST of UTC → negate + scale to seconds.
                // DST is already folded in, so no separate DST entry is needed.
                const offsetSec = -now.getTimezoneOffset() * 60;
                const utcTime = BigInt(now.getTime()) * 1000n;
                // -------------------------------------------------------------------
                // Step 1: SetTimeZone (optional — only devices with the TimeZone
                // feature support this command).
                //
                // Sending it first resets the device's internal time-source tracking.
                // Per spec §11.17.9.1, a node SHALL update UTCTime if its current
                // Granularity is NoTimeGranularity — which SetTimeZone triggers on
                // many firmware implementations (e.g. IKEA ALPSTUGA).
                // Without this pre-step the device may return TimeNotAccepted (code 1).
                // -------------------------------------------------------------------
                try {
                    await controllerNode.manager.invokeCommand(nodeId, ROOT_ENDPOINT, TIME_SYNC_CLUSTER_ID, "setTimeZone", {
                        timeZone: [{
                                // Total UTC offset in seconds; DST already included.
                                offset: offsetSec,
                                // validAt must encode as Matter epoch 0 ("valid from the
                                // start of the Matter epoch = 2000-01-01").
                                // Pass MATTER_EPOCH_START_UNIX_US so TlvEpochUs subtracts
                                // the offset and writes 0 on the wire.
                                validAt: MATTER_EPOCH_START_UNIX_US,
                            }],
                    });
                }
                catch (tzErr) {
                    // Device may not have the TimeZone feature — proceed to SetUTCTime.
                    this.debug(`matter-time-sync: SetTimeZone not applied for ${nodeId}: ${tzErr.message}`);
                }
                // -------------------------------------------------------------------
                // Step 2: SetDSTOffset — clear the DST table.
                // DST is already folded into offsetSec above, so the DST offset is 0.
                // An empty list tells the device there are no active DST rules.
                // Optional: devices without TimeZone feature lack this command.
                // -------------------------------------------------------------------
                try {
                    await controllerNode.manager.invokeCommand(nodeId, ROOT_ENDPOINT, TIME_SYNC_CLUSTER_ID, "setDstOffset", { dstOffset: [] });
                }
                catch (dstErr) {
                    this.debug(`matter-time-sync: SetDSTOffset not applied for ${nodeId}: ${dstErr.message}`);
                }
                // -------------------------------------------------------------------
                // Step 3: SetUTCTime — the essential operation.
                // utcTime is Unix epoch µs; TlvEpochUs converts to Matter epoch wire format.
                // -------------------------------------------------------------------
                await controllerNode.manager.invokeCommand(nodeId, ROOT_ENDPOINT, TIME_SYNC_CLUSTER_ID, "setUtcTime", { utcTime, granularity: GRANULARITY_MICROSECONDS, timeSource: TIME_SOURCE_ADMIN });
                // One toISOString() call; reused for both status badge and output payload.
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