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
const MATTER_EPOCH_START_UNIX_US = 946_684_800_000_000n;

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
        // Capture wall-clock once.
        const now = new Date();
        const utcTime = BigInt(now.getTime()) * 1_000n;

        // Full current UTC offset in seconds — DST already folded in.
        // E.g. CEST (summer, UTC+2) → getTimezoneOffset()=-120 → offsetSec=7200.
        // We merge DST into the timezone offset and explicitly tell the device
        // DST = 0 via SetDSTOffset below. This prevents the device from adding
        // its own built-in DST rules on top of our offset (which would shift
        // the displayed time by +1 h each day until the next sync).
        const offsetSec = -now.getTimezoneOffset() * 60;

        // One year from now as Unix epoch µs — used as the DSTOffset validUntil
        // so the device treats our explicit zero-DST rule as authoritative.
        // The daily sync will refresh this before it expires.
        const oneYearUs = BigInt(now.getTime() + 365 * 24 * 3600 * 1_000) * 1_000n;

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
          await controllerNode.manager.invokeCommand(
            nodeId,
            ROOT_ENDPOINT,
            TIME_SYNC_CLUSTER_ID,
            "setTimeZone",
            {
              timeZone: [{
                // Full current UTC offset in seconds (DST already merged in).
                offset: offsetSec,
                validAt: MATTER_EPOCH_START_UNIX_US,
              }],
            },
          );
        } catch (tzErr) {
          // Device may not have the TimeZone feature — proceed to SetUTCTime.
          this.debug(`matter-time-sync: SetTimeZone not applied for ${nodeId}: ${(tzErr as Error).message}`);
        }

        // -------------------------------------------------------------------
        // Step 2: SetDSTOffset — explicitly set DST = 0.
        // Optional: devices without TimeZone feature lack this command.
        // -------------------------------------------------------------------
        try {
          await controllerNode.manager.invokeCommand(
            nodeId,
            ROOT_ENDPOINT,
            TIME_SYNC_CLUSTER_ID,
            "setDstOffset",
            {
              // Send an explicit entry with offset=0 rather than an empty list.
              // An empty list lets devices apply their own built-in DST rules on
              // top of our timezone offset, adding +1 h each day (confirmed on
              // IKEA ALPSTUGA). An explicit zero entry with a far-future validUntil
              // tells the device "controller has set DST = 0, ignore internal rules".
              // The daily sync refreshes validUntil before it expires.
              // Reference: github.com/Loweack/Matter-Time-Sync v2.0.1 DST fix.
              dstOffset: [{
                offset: 0,
                validStarting: MATTER_EPOCH_START_UNIX_US, // encodes as 0 on wire
                validUntil: oneYearUs,
              }],
            },
          );
        } catch (dstErr) {
          this.debug(`matter-time-sync: SetDSTOffset not applied for ${nodeId}: ${(dstErr as Error).message}`);
        }

        // -------------------------------------------------------------------
        // Step 3: SetUTCTime — the essential operation.
        // utcTime is Unix epoch µs; TlvEpochUs converts to Matter epoch wire format.
        // -------------------------------------------------------------------
        await controllerNode.manager.invokeCommand(
          nodeId,
          ROOT_ENDPOINT,
          TIME_SYNC_CLUSTER_ID,
          "setUtcTime",
          { utcTime, granularity: GRANULARITY_MICROSECONDS, timeSource: TIME_SOURCE_ADMIN },
        );

        // One toISOString() call; reused for both status badge and output payload.
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
