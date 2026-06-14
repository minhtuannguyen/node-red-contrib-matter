import type { MatterControllerNode } from "../matter-controller/matter-controller.js";
import type { NodeRedAPI, NodeRedDef, NodeRedMessage, NodeRedNode } from "../../types/node-red.js";

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
const MATTER_EPOCH_START_UNIX_US = 946_684_800_000_000n;

// ---------------------------------------------------------------------------
// DST helpers
// ---------------------------------------------------------------------------

/**
 * Returns DST information for the current timezone at the given moment.
 *
 * stdOffsetSec:  standard (non-DST) UTC offset in seconds.
 * dstOffsetSec:  extra DST offset currently active in seconds (0 if not in DST).
 *
 * Derived entirely from getTimezoneOffset() on January and July dates —
 * no binary search, no hemisphere assumptions, no edge cases.
 */
function getDSTInfo(now: Date): {
  stdOffsetSec: number;
  dstOffsetSec: number;
} {
  const year = now.getFullYear();
  // Compare winter (Jan) and summer (Jul) offsets to isolate the standard offset.
  // getTimezoneOffset() is positive WEST of UTC, negative EAST — taking the
  // larger value gives the standard (non-DST) offset for any hemisphere.
  const janOffsetMin = new Date(year, 0, 1).getTimezoneOffset();
  const julOffsetMin = new Date(year, 6, 1).getTimezoneOffset();
  const stdOffsetMin = Math.max(janOffsetMin, julOffsetMin);
  const stdOffsetSec = -stdOffsetMin * 60;

  // Current offset includes DST when active.
  const currentOffsetSec = -now.getTimezoneOffset() * 60;
  const dstOffsetSec = currentOffsetSec - stdOffsetSec;

  return { stdOffsetSec, dstOffsetSec };
}

// ---------------------------------------------------------------------------
// Node definition
// ---------------------------------------------------------------------------

interface MatterTimeSyncConfig extends NodeRedDef {
  controller: string;
  nodeId: string;
}

module.exports = function (RED: NodeRedAPI) {
  function MatterTimeSync(
    this: NodeRedNode,
    config: MatterTimeSyncConfig,
  ) {
    RED.nodes.createNode(this, config);

    const controllerNode = RED.nodes.getNode(config.controller) as MatterControllerNode | null;

    if (!controllerNode) {
      this.error("No Matter Controller config node selected.");
      this.status({ fill: "red", shape: "ring", text: "no controller" });
      return;
    }

    this.status({ fill: "grey", shape: "ring", text: "idle" });

    this.on("input", async (msg: NodeRedMessage, send, done) => {
      const nodeId = (msg["nodeId"] as string | undefined) ?? config.nodeId;

      if (!nodeId) {
        const err = new Error("matter-time-sync: nodeId is required (configure the node or set msg.nodeId).");
        this.status({ fill: "red", shape: "dot", text: "nodeId missing" });
        done(err);
        return;
      }

      this.status({ fill: "yellow", shape: "dot", text: "syncing…" });

      try {
        const now = new Date();
        const utcTime = BigInt(now.getTime()) * 1_000n;

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
        const { stdOffsetSec, dstOffsetSec } = getDSTInfo(now);

        this.log(
          `matter-time-sync node=${nodeId}: UTC=${now.toISOString()} ` +
          `stdOffset=${stdOffsetSec}s dstOffset=${dstOffsetSec}s`,
        );

        // -------------------------------------------------------------------
        // Step 1: SetTimeZone — STANDARD offset only, no DST folded in.
        // Optional: only devices with the TimeZone feature support this.
        //
        // Sending it first resets the device's internal Granularity so
        // SetUTCTime is accepted without a TimeNotAccepted (code 1) error.
        // -------------------------------------------------------------------
        try {
          await controllerNode.manager.invokeCommand(
            nodeId,
            ROOT_ENDPOINT,
            TIME_SYNC_CLUSTER_ID,
            "setTimeZone",
            {
              timeZone: [{
                offset: stdOffsetSec,               // standard offset, e.g. 3600 for CET
                validAt: MATTER_EPOCH_START_UNIX_US, // encodes as 0 on wire (= from epoch start)
              }],
            },
          );
          this.log(`matter-time-sync node=${nodeId}: SetTimeZone OK (offset=${stdOffsetSec}s)`);
        } catch (tzErr) {
          this.warn(`matter-time-sync node=${nodeId}: SetTimeZone failed: ${(tzErr as Error).message}`);
        }

        // -------------------------------------------------------------------
        // Step 2: SetDSTOffset — real DST offset, open-ended validity.
        // Optional: only devices with the TimeZone feature support this.
        //
        // Send the actual DST adjustment (e.g. 3600 for Europe) so the device
        // computes: LocalTime = UTC + stdOffset + dstOffset = correct local time.
        //
        // validStarting = Matter epoch 0 (year 2000) means "always active".
        // validUntil = 1 year from now, refreshed by the daily sync.
        //
        // If the device ignores SetDSTOffset and uses its factory DST (also
        // typically 3600 for European devices), UTC + 3600 + 3600 = UTC+2 = CEST.
        // Either way the result is correct — this is the key robustness property.
        //
        // Previous approach (offset=0) failed because the ALPSTUGA applies its
        // own built-in DST on top of the timezone offset regardless, adding +1h.
        // Confirmed: reddit.com/r/homeassistant/comments/1q0y8nk
        // -------------------------------------------------------------------
        try {
          const oneYearUs = BigInt(now.getTime() + 365 * 24 * 3600 * 1_000) * 1_000n;
          const dstList: Array<{ offset: number; validStarting: bigint; validUntil: bigint }> =
            dstOffsetSec > 0
              ? [{ offset: dstOffsetSec, validStarting: MATTER_EPOCH_START_UNIX_US, validUntil: oneYearUs }]
              : [];

          await controllerNode.manager.invokeCommand(
            nodeId,
            ROOT_ENDPOINT,
            TIME_SYNC_CLUSTER_ID,
            "setDstOffset",
            { dstOffset: dstList },
          );
          this.log(`matter-time-sync node=${nodeId}: SetDSTOffset OK (entries=${dstList.length}, offset=${dstOffsetSec}s)`);
        } catch (dstErr) {
          this.warn(`matter-time-sync node=${nodeId}: SetDSTOffset failed: ${(dstErr as Error).message}`);
        }

        // -------------------------------------------------------------------
        // Step 3: SetUTCTime — the essential operation.
        // utcTime is Unix epoch µs; TlvEpochUs converts to Matter epoch on wire.
        // -------------------------------------------------------------------
        await controllerNode.manager.invokeCommand(
          nodeId,
          ROOT_ENDPOINT,
          TIME_SYNC_CLUSTER_ID,
          "setUtcTime",
          { utcTime, granularity: GRANULARITY_MICROSECONDS, timeSource: TIME_SOURCE_ADMIN },
        );
        this.log(`matter-time-sync node=${nodeId}: SetUTCTime OK`);

        const syncedAt = new Date().toISOString();
        this.status({ fill: "green", shape: "dot", text: `synced ${syncedAt.slice(11, 19)} UTC` });
        send({ ...msg, payload: { synced: true, syncedAt }, topic: "time-sync" });
        done();
      } catch (err) {
        const e = err as Error;
        this.status({ fill: "red", shape: "dot", text: e.message.slice(0, 40) });
        done(e);
      }
    });
  }

  RED.nodes.registerType(
    "matter-time-sync",
    MatterTimeSync as unknown as new (...args: unknown[]) => void,
  );
};
