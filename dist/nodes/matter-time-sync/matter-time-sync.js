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
 */
const GRANULARITY_MICROSECONDS = 4;
/**
 * TimeSourceEnum.Admin = 2.
 */
const TIME_SOURCE_ADMIN = 2;
/**
 * Unix epoch-microseconds corresponding to Matter epoch start (2000-01-01 00:00:00 UTC).
 *
 * matter.js TlvEpochUs expects Unix epoch µs and subtracts this offset internally
 * before encoding on the wire.  Passing this constant encodes as 0 on the wire
 * (= "valid from Matter epoch start = beginning of time").
 *
 * Cross-check: new Date('2000-01-01T00:00:00Z').getTime() * 1_000 === this value.
 */
const MATTER_EPOCH_START_UNIX_US = 946684800000000n;
// ---------------------------------------------------------------------------
// DST helpers
// ---------------------------------------------------------------------------
/**
 * Finds the DST transition moment for a given year using binary search.
 *
 * direction='start': finds the moment clocks spring forward (std → DST).
 * direction='end':   finds the moment clocks fall back (DST → std).
 *
 * Returns null if the timezone has no DST.
 * Precision: within 1 minute.
 *
 * Works for both northern (DST in summer) and southern hemisphere timezones.
 *
 * Confirmed working for IKEA ALPSTUGA — see reddit.com/r/homeassistant/comments/1q0y8nk
 */
function findDSTTransition(year, direction) {
    const janOffset = new Date(year, 0, 1).getTimezoneOffset();
    const julOffset = new Date(year, 6, 1).getTimezoneOffset();
    if (janOffset === julOffset)
        return null; // No DST in this timezone
    const stdOffset = Math.max(janOffset, julOffset); // Less negative = standard time
    // Search window: first half of year for DST start, second half for DST end.
    // This works for both hemispheres because binary search doesn't assume direction.
    let lo;
    let hi;
    if (direction === "start") {
        lo = new Date(year, 0, 1); // Jan 1
        hi = new Date(year, 6, 15); // Jul 15
    }
    else {
        lo = new Date(year, 6, 15); // Jul 15
        hi = new Date(year + 1, 0, 1); // Jan 1 next year
    }
    // Binary search to within 1-minute precision.
    while (hi.getTime() - lo.getTime() > 60_000) {
        const mid = new Date((lo.getTime() + hi.getTime()) / 2);
        const midIsStd = mid.getTimezoneOffset() === stdOffset;
        if (direction === "start") {
            // Looking for std→DST: left of transition = standard, right = DST.
            if (midIsStd)
                lo = mid;
            else
                hi = mid;
        }
        else {
            // Looking for DST→std: left = DST, right = standard.
            if (!midIsStd)
                lo = mid;
            else
                hi = mid;
        }
    }
    return hi;
}
/**
 * Returns DST information for the current timezone at the given moment.
 *
 * stdOffsetSec:  the standard (non-DST) UTC offset in seconds.
 * dstOffsetSec:  the extra DST offset in seconds (0 if not in DST / no DST timezone).
 * dstStart:      Date when DST became active this year (null if no DST).
 * dstEnd:        Date when DST deactivates this year (null if no DST).
 */
function getDSTInfo(now) {
    const year = now.getFullYear();
    const janOffsetMin = new Date(year, 0, 1).getTimezoneOffset();
    const julOffsetMin = new Date(year, 6, 1).getTimezoneOffset();
    // Standard = larger getTimezoneOffset value (less negative for EAST zones).
    const stdOffsetMin = Math.max(janOffsetMin, julOffsetMin);
    const stdOffsetSec = -stdOffsetMin * 60;
    // Current total offset (includes DST if active).
    const currentOffsetSec = -now.getTimezoneOffset() * 60;
    const dstOffsetSec = currentOffsetSec - stdOffsetSec;
    if (janOffsetMin === julOffsetMin) {
        // No DST in this timezone.
        return { stdOffsetSec, dstOffsetSec: 0, dstStart: null, dstEnd: null };
    }
    const dstStart = findDSTTransition(year, "start");
    const dstEnd = findDSTTransition(year, "end");
    return { stdOffsetSec, dstOffsetSec, dstStart, dstEnd };
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
            const nodeId = msg["nodeId"] ?? config.nodeId;
            if (!nodeId) {
                const err = new Error("matter-time-sync: nodeId is required (configure the node or set msg.nodeId).");
                this.status({ fill: "red", shape: "dot", text: "nodeId missing" });
                done(err);
                return;
            }
            this.status({ fill: "yellow", shape: "dot", text: "syncing…" });
            try {
                const now = new Date();
                const utcTime = BigInt(now.getTime()) * 1000n;
                // -------------------------------------------------------------------
                // Compute timezone offsets.
                //
                // The Matter spec (§11.17.15) computes local time as:
                //   LocalTime = UTCTime + TimeZone.offset + DSTOffset.offset
                //
                // So TimeZone.offset must be the STANDARD (non-DST) UTC offset, and
                // DSTOffset.offset must carry the actual DST adjustment separately.
                //
                // Folding DST into TimeZone.offset (e.g. sending 7200 for CEST) and
                // setting DSTOffset=0 causes firmware (IKEA ALPSTUGA) to later add its
                // own built-in DST on top, resulting in UTC+3 = 1 h ahead of local.
                //
                // Fix confirmed by reddit.com/r/homeassistant/comments/1q0y8nk — the
                // device requires actual DST transition dates, not a blanket "DST=0".
                // -------------------------------------------------------------------
                const { stdOffsetSec, dstOffsetSec, dstStart, dstEnd } = getDSTInfo(now);
                this.log(`matter-time-sync node=${nodeId}: UTC=${now.toISOString()} ` +
                    `stdOffset=${stdOffsetSec}s dstOffset=${dstOffsetSec}s ` +
                    `dstStart=${dstStart?.toISOString() ?? "n/a"} dstEnd=${dstEnd?.toISOString() ?? "n/a"}`);
                // -------------------------------------------------------------------
                // Step 1: SetTimeZone — STANDARD offset only, no DST folded in.
                // Optional: only devices with the TimeZone feature support this.
                //
                // Sending it first resets the device's internal Granularity so
                // SetUTCTime is accepted without a TimeNotAccepted (code 1) error.
                // -------------------------------------------------------------------
                try {
                    await controllerNode.manager.invokeCommand(nodeId, ROOT_ENDPOINT, TIME_SYNC_CLUSTER_ID, "setTimeZone", {
                        timeZone: [{
                                offset: stdOffsetSec, // standard offset, e.g. 3600 for CET
                                validAt: MATTER_EPOCH_START_UNIX_US, // encodes as 0 (= from epoch start)
                            }],
                    });
                    this.log(`matter-time-sync node=${nodeId}: SetTimeZone OK (offset=${stdOffsetSec}s)`);
                }
                catch (tzErr) {
                    this.warn(`matter-time-sync node=${nodeId}: SetTimeZone failed: ${tzErr.message}`);
                }
                // -------------------------------------------------------------------
                // Step 2: SetDSTOffset — actual DST transition dates with real offset.
                // Optional: only devices with the TimeZone feature support this.
                //
                // Send the real DST adjustment (e.g. 3600 for Europe) bounded by the
                // actual calendar transition dates.  Devices that ignore this command
                // will apply their own factory DST (also typically 3600) on top of our
                // standard TimeZone.offset, giving the correct total.
                //
                // An empty list or a blanket "offset=0, validStarting=epoch0" entry
                // is NOT sufficient: the ALPSTUGA ignores it and applies its own DST,
                // producing a 1-hour-ahead error.
                // -------------------------------------------------------------------
                try {
                    let dstList;
                    if (dstStart && dstEnd && dstOffsetSec > 0) {
                        // DST is active (or will be) this year: send the real entry.
                        dstList = [{
                                offset: dstOffsetSec, // e.g. 3600
                                validStarting: BigInt(dstStart.getTime()) * 1000n, // Unix epoch µs → TlvEpochUs → Matter epoch on wire
                                validUntil: BigInt(dstEnd.getTime()) * 1000n,
                            }];
                    }
                    else {
                        // No DST in this timezone, or currently in standard time.
                        dstList = [];
                    }
                    await controllerNode.manager.invokeCommand(nodeId, ROOT_ENDPOINT, TIME_SYNC_CLUSTER_ID, "setDstOffset", { dstOffset: dstList });
                    this.log(`matter-time-sync node=${nodeId}: SetDSTOffset OK (entries=${dstList.length}, offset=${dstOffsetSec}s)`);
                }
                catch (dstErr) {
                    this.warn(`matter-time-sync node=${nodeId}: SetDSTOffset failed: ${dstErr.message}`);
                }
                // -------------------------------------------------------------------
                // Step 3: SetUTCTime — the essential operation.
                // utcTime is Unix epoch µs; TlvEpochUs converts to Matter epoch on wire.
                // -------------------------------------------------------------------
                await controllerNode.manager.invokeCommand(nodeId, ROOT_ENDPOINT, TIME_SYNC_CLUSTER_ID, "setUtcTime", { utcTime, granularity: GRANULARITY_MICROSECONDS, timeSource: TIME_SOURCE_ADMIN });
                this.log(`matter-time-sync node=${nodeId}: SetUTCTime OK`);
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