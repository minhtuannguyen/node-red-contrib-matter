/**
 * ControllerManager — wraps the matter.js CommissioningController in a
 * Node-RED-friendly singleton (one per storage path).
 *
 * @matter/nodejs is loaded lazily inside _doStart() so that Boot.init fires
 * after environment configuration is applied.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CommissioningController } from "@project-chip/matter.js";
import { NodeStates } from "@project-chip/matter.js/device";
import type { CommissioningControllerNodeOptions, PairedNode } from "@project-chip/matter.js/device";
import { Logger, LogLevel } from "@matter/general";
import { ClusterId, EndpointNumber, ManualPairingCodeCodec, NodeId } from "@matter/types";

const logger = Logger.get("ControllerManager");

// Well-known Matter cluster ID → human-readable name map
const CLUSTER_NAMES: Record<number, string> = {
  0x0003: "Identify",
  0x0004: "Groups",
  0x0005: "Scenes",
  0x0006: "OnOff",
  0x0008: "LevelControl",
  0x000F: "BinaryInputBasic",
  0x001D: "Descriptor",
  0x001E: "Binding",
  0x001F: "AccessControl",
  0x0025: "Actions",
  0x0028: "BasicInformation",
  0x0029: "OtaSoftwareUpdateProvider",
  0x002A: "OtaSoftwareUpdateRequestor",
  0x002B: "LocalizationConfiguration",
  0x002C: "TimeFormatLocalization",
  0x002D: "UnitLocalization",
  0x002E: "PowerSourceConfiguration",
  0x002F: "PowerSource",
  0x0030: "GeneralCommissioning",
  0x0031: "NetworkCommissioning",
  0x0032: "DiagnosticLogs",
  0x0033: "GeneralDiagnostics",
  0x0034: "SoftwareDiagnostics",
  0x0035: "ThreadNetworkDiagnostics",
  0x0036: "WiFiNetworkDiagnostics",
  0x0037: "EthernetNetworkDiagnostics",
  0x0038: "TimeSynchronization",
  0x003C: "AdministratorCommissioning",
  0x003E: "OperationalCredentials",
  0x003F: "GroupKeyManagement",
  0x0040: "FixedLabel",
  0x0041: "UserLabel",
  0x0045: "BooleanState",
  0x0050: "ModeSelect",
  0x0060: "IcdManagement",
  0x0101: "DoorLock",
  0x0102: "WindowCovering",
  0x0200: "PumpConfigurationAndControl",
  0x0201: "Thermostat",
  0x0202: "FanControl",
  0x0204: "ThermostatUserInterfaceConfiguration",
  0x0300: "ColorControl",
  0x0301: "BallastConfiguration",
  0x0400: "IlluminanceMeasurement",
  0x0402: "TemperatureMeasurement",
  0x0403: "PressureMeasurement",
  0x0404: "FlowMeasurement",
  0x0405: "RelativeHumidityMeasurement",
  0x0406: "OccupancySensing",
  0x040C: "CarbonMonoxideConcentrationMeasurement",
  0x040D: "CarbonDioxideConcentrationMeasurement",
  0x0413: "Pm25ConcentrationMeasurement",
  0x041A: "FormaldehydeConcentrationMeasurement",
  0x042A: "Pm1ConcentrationMeasurement",
  0x042B: "Pm10ConcentrationMeasurement",
  0x042C: "TotalVolatileOrganicCompoundsConcentrationMeasurement",
  0x042D: "RadonConcentrationMeasurement",
  0x0503: "WakeOnLan",
  0x0504: "Channel",
  0x0505: "TargetNavigator",
  0x0506: "MediaPlayback",
  0x0507: "MediaInput",
  0x0508: "LowPower",
  0x0509: "KeypadInput",
  0x050A: "ContentLauncher",
  0x050B: "AudioOutput",
  0x050C: "ApplicationLauncher",
  0x050D: "ApplicationBasic",
  0x050E: "AccountLogin",
  0x0510: "ContentControl",
  0x0511: "ContentAppObserver",
  0x0700: "UnitTesting",
  0x0750: "ElectricalMeasurement",
  0x0090: "ElectricalPowerMeasurement",
  0x0091: "ElectricalEnergyMeasurement",
  0x009C: "DeviceEnergyManagementMode",
  0x0B04: "ElectricalEnergyMeasurement",
  0x0B05: "ElectricalPowerMeasurement",
  0x0B09: "ValveConfigurationAndControl",
  0x0B0B: "DeviceEnergyManagement",
  0x0B0C: "EnergyEvse",
};

/** Returns true when a string key is a named (non-numeric) property. */
const isNamed = (k: string) => isNaN(Number(k));

/**
 * Returns a human-readable name for the given Matter cluster ID.
 * Unknown IDs are cached so the hex-string is only formatted once per unique
 * cluster, eliminating per-event string allocation in the subscription hot path.
 */
const unknownClusterNameCache = new Map<number, string>();
function getClusterName(clusterId: number): string {
  const known = CLUSTER_NAMES[clusterId];
  if (known) return known;
  let cached = unknownClusterNameCache.get(clusterId);
  if (!cached) {
    cached = `0x${clusterId.toString(16).toUpperCase().padStart(4, '0')}`;
    unknownClusterNameCache.set(clusterId, cached);
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Public data shapes
// ---------------------------------------------------------------------------

export interface ClusterInfo {
  clusterId: number;
  clusterIdHex: string;
  clusterName: string;
  attributes: string[];
  commands: string[];
  events: string[];
}

export interface DeviceRegistryEntry {
  label: string;
  nodeId: string;
  discoveredAt: string;
  discovery: DeviceDescription;
}

export type DeviceRegistry = Record<string, DeviceRegistryEntry>;

export interface EndpointInfo {
  endpointId: number;
  clusterIds: number[];
}

export interface EndpointDetail {
  endpointId: number;
  clusters: ClusterInfo[];
}

export interface DeviceDescription {
  nodeId: string;
  endpoints: EndpointDetail[];
}

export interface NodeInfo {
  nodeId: string;
  endpoints: EndpointInfo[];
}

export interface SignalInfo {
  type: 'Thread' | 'unknown';
  /** Minimum neighbor RSSI in dBm — used for color */
  rssi?: number;
  /** Average neighbor LQI (0–255) */
  lqi?: number;
  /** Number of direct Thread neighbors */
  neighborCount?: number;
  /** Times this device detached from the network since last boot */
  detachedCount?: number;
  /** Times this device changed its parent router since last boot */
  parentChanges?: number;
  /** Total connection attempts since last boot */
  attachAttempts?: number;
  level: 'good' | 'fair' | 'poor' | 'unknown';
}

export interface AttributeChangedEvent {
  nodeId: string;
  endpointId: number;
  clusterId: number;
  clusterName: string;
  attributeName: string;
  value: unknown;
  /** ISO-8601 string — avoids heap-allocating a Date object in the hot callback path. */
  timestamp: string;
}

export interface EventTriggeredEvent {
  nodeId: string;
  endpointId: number;
  clusterId: number;
  clusterName: string;
  eventName: string;
  events: unknown[];
  /** ISO-8601 string — avoids heap-allocating a Date object in the hot callback path. */
  timestamp: string;
}

export type AttributeChangeHandler = (event: AttributeChangedEvent) => void;
export type EventTriggeredHandler = (event: EventTriggeredEvent) => void;

/**
 * Optional filter passed when registering a subscription handler.
 * When `clusterId` is provided the controller uses a targeted per-cluster
 * subscription instead of `subscribeAllAttributesAndEvents`, which avoids
 * caching every attribute on the device and reduces memory significantly.
 */
export interface SubscriptionFilter {
  endpointId?: number;
  /** If set, only this cluster is subscribed (selective mode). */
  clusterId?: number;
  /** Further narrow to a single attribute within the cluster. */
  attributeName?: string;
  /** Further narrow to a single event within the cluster. */
  eventName?: string;
}

// ---------------------------------------------------------------------------
// Singleton registry (one manager per storage path)
// ---------------------------------------------------------------------------

const instances = new Map<string, ControllerManager>();

// ---------------------------------------------------------------------------
// ControllerManager
// ---------------------------------------------------------------------------

export class ControllerManager {
  private controller?: CommissioningController;
  private started = false;
  /** If start() is already in progress, all concurrent callers await this same promise. */
  private startingPromise?: Promise<void>;

  /** nodeId -> { node, subscribed } */
  private readonly connectedNodes = new Map<
    string,
    { node: PairedNode; subscribed: boolean }
  >();

  /** nodeId -> attribute handlers */
  private readonly attrHandlers = new Map<string, Set<AttributeChangeHandler>>();
  /** nodeId -> event handlers */
  private readonly eventHandlers = new Map<string, Set<EventTriggeredHandler>>();
  /** nodeId -> (handler -> filter) — used for callback-level dispatch filtering */
  private readonly attrHandlerFilters = new Map<string, Map<AttributeChangeHandler, SubscriptionFilter>>();
  private readonly eventHandlerFilters = new Map<string, Map<EventTriggeredHandler, SubscriptionFilter>>();
  /**
   * Per-node connection lock. If a connectNode() call is already in progress for
   * a node, concurrent callers share the same promise instead of each starting
   * an independent CASE session attempt (which could each take up to 30 s when
   * the device is offline, wasting memory and network retries).
   */
  private readonly connectingPromises = new Map<string, Promise<PairedNode>>();

  /**
   * Per-node subscription lock. If a subscription is already in progress for a
   * node, concurrent callers await the same promise instead of each sending
   * their own Subscribe Request to the device.
   */
  private readonly subscribingPromises = new Map<string, Promise<void>>();

  /**
   * Per-node stateChanged listeners that re-subscribe after the device
   * reconnects following an outage. Kept here so they can be cleanly
   * detached in close() and removeDevice().
   */
  private readonly stateHandlers = new Map<string, (state: NodeStates) => void>();

  /**
   * Maps nodeId → PairedNode for nodes whose stateHandler is active but whose
   * connectedNodes entry has been evicted (i.e. the node is in Disconnected or
   * Reconnecting state).  Required so close() can call .off(handler) on the
   * correct node even when the node is absent from connectedNodes.
   */
  private readonly stateHandlerNodes = new Map<string, PairedNode>();

  /**
   * Tracks the last time we received a subscription report (attribute or event)
   * for each node. Used by the health check to detect stale subscriptions on
   * devices with poor/intermittent connectivity (e.g. Thread sensors with RSSI < -90 dBm).
   */
  private readonly lastReportTime = new Map<string, number>();

  /**
   * Periodic health check timer that detects stale subscriptions and triggers
   * reconnection. Runs every 60 seconds to catch devices that silently stop
   * sending reports without triggering Matter.js state changes.
   */
  private healthCheckInterval?: ReturnType<typeof setInterval>;

  /** Persisted registry of commissioned devices with their discovery data */
  private registry: DeviceRegistry = {};
  private registryPath = "";

  private constructor(
    private readonly storagePath: string,
    private readonly port: number,
    private readonly logLevel: string = "Info",
  ) {}

  // ----------- Singleton access ------------------------------------------

  static getInstance(storagePath: string, port: number, logLevel = "Info"): ControllerManager {
    if (!instances.has(storagePath)) {
      instances.set(storagePath, new ControllerManager(storagePath, port, logLevel));
    } else {
      // Apply log level even if instance already exists (e.g. after hot-redeploy)
      instances.get(storagePath)!.applyLogLevel(logLevel);
    }
    return instances.get(storagePath)!;
  }

  static removeInstance(storagePath: string): void {
    instances.delete(storagePath);
  }

  private applyLogLevel(level: string): void {
    const map: Record<string, LogLevel> = {
      Debug:  LogLevel.DEBUG,
      Info:   LogLevel.INFO,
      Notice: LogLevel.NOTICE,
      Warn:   LogLevel.WARN,
      Error:  LogLevel.ERROR,
      Fatal:  LogLevel.FATAL,
    };
    Logger.defaultLogLevel = map[level] ?? LogLevel.INFO;
  }

  /**
   * Returns true if any attribute or event handler is registered for the node.
   * Used to decide between a persistent cached connection (subscribed device)
   * and a transient connect-use-disconnect pattern (command/read-only device).
   */
  private hasActiveHandlers(nodeIdStr: string): boolean {
    return (
      (this.attrHandlers.get(nodeIdStr)?.size ?? 0) > 0 ||
      (this.eventHandlers.get(nodeIdStr)?.size ?? 0) > 0
    );
  }

  /**
   * If the node has no active handlers it was connected transiently just for
   * this operation. Disconnect it now to free the CASE session and cluster
   * client objects (~15 MB per device).
   */
  private async releaseIfTransient(nodeIdStr: string, node: PairedNode): Promise<void> {
    if (!this.hasActiveHandlers(nodeIdStr)) {
      this.connectedNodes.delete(nodeIdStr);
      await node.disconnect().catch(() => {/* ignore disconnect errors */});
    }
  }

  /**
   * Called after handler removal to disconnect nodes that no longer have any
   * active handlers. Asynchronously cleans up the connection in the background
   * without blocking the removal operation.
   */
  private releaseIfNoHandlers(nodeIdStr: string): void {
    if (this.hasActiveHandlers(nodeIdStr)) return;
    
    const entry = this.connectedNodes.get(nodeIdStr);
    if (!entry) return;
    
    // Clean up in background - don't await to avoid blocking handler removal
    (async () => {
      // Detach state handler
      const stateHandler = this.stateHandlers.get(nodeIdStr);
      if (stateHandler) {
        entry.node.events.stateChanged.off(stateHandler);
        this.stateHandlers.delete(nodeIdStr);
        this.stateHandlerNodes.delete(nodeIdStr);
      }
      
      // Remove from maps
      this.connectedNodes.delete(nodeIdStr);
      this.lastReportTime.delete(nodeIdStr);
      
      // Disconnect the node
      await entry.node.disconnect().catch((e) => {
        logger.debug(`Disconnect after handler removal failed for ${nodeIdStr}: ${e}`);
      });
      
      logger.debug(`Released connection for ${nodeIdStr} after last handler removed`);
    })();
  }

  // ----------- Lifecycle -------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;

    // If a concurrent start() is already in progress, wait for it instead of
    // creating a second CommissioningController on the same storage path.
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = this._doStart().finally(() => {
      this.startingPromise = undefined;
    });
    return this.startingPromise;
  }

  private async _doStart(): Promise<void> {
    if (this.started) return;

    // matter.js StorageBackendDisk writes files atomically via a .tmp rename.
    // The directory must already exist or both the write and rename will fail
    // with ENOENT. Pre-create the full path including the controller-id subdir.
    const CONTROLLER_ID = "node-red-matter";
    mkdirSync(join(this.storagePath, CONTROLLER_ID), { recursive: true });

    this.registryPath = join(this.storagePath, CONTROLLER_ID, "registry.json");
    this.loadRegistry();

    // Remove storage files for decommissioned nodes before matter.js loads the
    // cache into memory. Safe: only deletes endpoint attribute-value files for
    // nodeIds that are no longer in the registry. Commissioning/fabric data
    // (fabrics.*, sessions.*) is never touched.
    await this.cleanStaleNodeCache();

    // Apply log level before starting the controller so that all matter.js
    // subsystems (CASE, mDNS, TLV, protocol handlers) respect the configured
    // level from the first log call. This was previously a dead config option.
    this.applyLogLevel(this.logLevel);

    // Loaded here (not at module top level) so Boot.init fires after
    // environment configuration. Uses file storage — the @matter/nodejs@0.17.0
    // SQLite driver has a concurrency bug (nested BEGIN TRANSACTION when
    // multiple devices connect simultaneously) so we stay on file storage.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@matter/nodejs");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Environment } = require("@matter/general") as typeof import("@matter/general");
    const env = Environment.default;
    env.vars.set("storage.path", this.storagePath);

    // Tune Thread network profile: halve concurrent CASE exchanges (4→2) and
    // increase inter-exchange gap (100ms→250ms). Each open exchange holds crypto
    // state in RAM; tighter limits cut peak memory during the startup subscription
    // storm when multiple Thread devices connect simultaneously.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { NetworkProfiles } = require("@matter/protocol") as typeof import("@matter/protocol");
      // Pass only the thread key — the setter deep-merges from the static
      // NetworkProfiles.defaults so all other profiles (fast, unknown, etc.)
      // remain untouched. Using the setter (not .defaults.thread) is required
      // because the property has only a setter, never a getter.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (env.get(NetworkProfiles) as any).defaults = {
        thread: {
          exchanges: 2,
          delay: 250,                                       // ms (up from 100)
          connect:      { exchanges: 2, timeout: 30_000 }, // keep 30s timeout
          probeAddress: { exchanges: 1, timeout: 15_000 }, // 15s timeout kept
        },
      };
    } catch {
      logger.debug("NetworkProfiles Thread tuning not available — skipping");
    }

    this.controller = new CommissioningController({
      environment: {
        environment: env,
        id: "node-red-matter",
      },
      autoConnect: false,
      adminFabricLabel: "node-red-matter",
      basicInformation: {
        productName: "node-red-contrib-matter",
      },
    });

    try {
      await this.controller.start();
    } catch (e) {
      // Clear the partially-initialised controller so the next start() attempt
      // creates a fresh one rather than trying to reuse a broken instance that
      // may still hold a port binding or crypto state.
      this.controller = undefined;
      throw e;
    }
    this.started = true;

    // Recovery: if any commissioned nodes are absent from registry.json (e.g., the
    // file was moved into the SQLite migration backup and the process exited before
    // the write-back completed), add a placeholder entry immediately so the device
    // appears in the UI dropdown.  registerDevice() fills in the real label and
    // cluster info in the background once the device is reachable.
    const commissionedIds = (this.controller.getCommissionedNodes() ?? []).map(id => id.toString());
    const missingIds = commissionedIds.filter(id => !this.registry[id]);
    if (missingIds.length > 0) {
      logger.warn(`${missingIds.length} commissioned device(s) missing from registry — recovering`);
      for (const id of missingIds) {
        this.registry[id] = {
          label: `Device ${id}`,
          nodeId: id,
          discoveredAt: new Date().toISOString(),
          discovery: { nodeId: id, endpoints: [] },
        };
        this.registerDevice(id).catch(e =>
          logger.warn(`Auto re-register failed for ${id}: ${e}`),
        );
      }
    }

    // Persist registry at startup so the file is always current in the storage
    // directory after any storage-path changes or clean installations.
    await writeFile(this.registryPath, JSON.stringify(this.registry), "utf8")
      .catch(e => logger.warn(`Failed to persist registry on startup: ${e}`));

    this.startHealthCheck();
    logger.info(`Matter controller started — storage: ${this.storagePath}`);
  }

  async close(): Promise<void> {
    if (!this.started) return;
    // Stop health check monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    // Detach all stateChanged listeners. Since we evict connectedNodes entries on
    // Disconnect, some nodes may have an active stateHandler but no connectedNodes
    // entry; stateHandlerNodes holds their PairedNode reference for exactly this case.
    for (const [nodeIdStr, handler] of this.stateHandlers) {
      const node =
        this.connectedNodes.get(nodeIdStr)?.node ??
        this.stateHandlerNodes.get(nodeIdStr);
      if (node) node.events.stateChanged.off(handler);
    }
    this.stateHandlers.clear();
    this.stateHandlerNodes.clear();
    this.connectedNodes.clear();
    this.lastReportTime.clear();
    this.attrHandlers.clear();
    this.eventHandlers.clear();
    this.attrHandlerFilters.clear();
    this.eventHandlerFilters.clear();
    // Cancel any in-flight connection / subscription promises so they don't
    // touch the closed controller after Node-RED redeploys.
    this.connectingPromises.clear();
    this.subscribingPromises.clear();
    await this.controller?.close();
    this.started = false;
    ControllerManager.removeInstance(this.storagePath);
    logger.info("Matter controller stopped");
  }

  // ----------- Commissioning ---------------------------------------------

  /**
   * Commission a device using an 11-digit manual pairing code (e.g. "12345678901").
   * The device must already be on the IP network (multi-admin / open commissioning
   * window from another controller such as Apple Home).
   *
   * @param pairingCode - Manual pairing code (hyphens are stripped automatically)
   * @param knownAddress - Optional IPv6/IPv4 address to skip mDNS discovery (useful
   *   for Thread devices whose commissioning mDNS is not bridged to the IP network).
   *   Format: "fd00::1234" or "192.168.1.50"
   *
   * Returns basic info about the newly-commissioned node.
   */
  async commission(pairingCode: string, knownAddress?: string, labelOverride?: string): Promise<NodeInfo> {
    await this.start();
    const ctrl = this.requireController();

    const { shortDiscriminator, passcode } = ManualPairingCodeCodec.decode(pairingCode);

    // «NodeCommissioningOptions» is not re-exported from the device sub-path;
    // we let TypeScript infer it from the commissionNode() overload.
    const options: Record<string, unknown> = {
      discovery: {
        identifierData: { shortDiscriminator },
        discoveryCapabilities: { onIpNetwork: true },
        ...(knownAddress
          ? { knownAddress: { ip: knownAddress, port: 5540, type: "udp" } }
          : {}),
      },
      passcode,
      commissioning: {
        // 2 = IndoorOutdoor — most permissive regulatory location
        regulatoryLocation: 2 as never,
        regulatoryCountryCode: "XX",
      },
    };

    const nodeId = await ctrl.commissionNode(options as never);
    const nodeIdStr = nodeId.toString();
    logger.info(`Commissioned node: ${nodeIdStr}`);

    // Do NOT connect immediately — device reboots after joining fabric and won't
    // be reachable for several seconds. Return a minimal response right away and
    // register (connect + discover) in the background once it's back online.
    const nodeInfo: NodeInfo = { nodeId: nodeIdStr, endpoints: [] };
    this.registerDevice(nodeIdStr, labelOverride).catch(e =>
      logger.warn(`Device registration failed for ${nodeIdStr}: ${e}`),
    );
    return nodeInfo;
  }

  // ----------- Node access -----------------------------------------------

  /**
   * Returns a list of commissioned node IDs (as decimal strings).
   */
  listCommissionedNodes(): string[] {
    return (this.controller?.getCommissionedNodes() ?? []).map(id => id.toString());
  }

  /**
   * Returns a connected PairedNode, creating the connection on first call.
   *
   * @param nodeIdStr  Decimal or "0x…" hex string representation of the NodeId.
   * @param withSubscription  When true, ensures the node is subscribed to all
   *                          attributes and events before returning.
   */
  async getOrConnectNode(nodeIdStr: string, withSubscription: boolean): Promise<PairedNode> {
    await this.start();
    const existing = this.connectedNodes.get(nodeIdStr);

    if (existing) {
      if (withSubscription && !existing.subscribed) {
        await this.activateSubscriptions(nodeIdStr, existing.node);
        existing.subscribed = true;
      }
      return existing.node;
    }

    const ctrl = this.requireController();
    const nodeId = NodeId(BigInt(nodeIdStr));

    // Deduplicate concurrent connect attempts for the same node. Without this,
    // 100 messages arriving for an offline device each start an independent 30-s
    // CASE session timeout, exhausting sockets and delaying all responses.
    let connectWork = this.connectingPromises.get(nodeIdStr);
    if (!connectWork) {
      // Manage subscriptions explicitly — matter.js autoSubscribe sends a full
      // subscribeAllAttributesAndEvents which we replace with selective per-cluster
      // subscriptions where possible.
      const connectOptions: CommissioningControllerNodeOptions = {
        autoSubscribe: false,
        // subscribeMinIntervalFloorSeconds / subscribeMaxIntervalCeilingSeconds
        // are not set here: they configure NetworkClient.defaultSubscription which
        // is only used by the built-in autoSubscribe path. Since autoSubscribe is
        // false our manual subscribeMultipleAttributesAndEvents calls carry their
        // own interval parameters directly.
      };
      connectWork = (async (): Promise<PairedNode> => {
        const node = await ctrl.connectNode(nodeId, connectOptions);
        // Wait for local initialization (uses previously cached data if available).
        if (!node.initialized) await node.events.initialized;
        // Guard against close() having run while we awaited the network.
        // If started is false the controller is gone; don't populate the map
        // with a stale entry that would be returned as "connected" on next start.
        if (this.started) {
          this.connectedNodes.set(nodeIdStr, { node, subscribed: false });
        }
        return node;
      })().finally(() => {
        this.connectingPromises.delete(nodeIdStr);
      });
      this.connectingPromises.set(nodeIdStr, connectWork);
    }

    const node = await connectWork;

    if (withSubscription) {
      await this.activateSubscriptions(nodeIdStr, node);
      // Re-fetch from the map: close() may have cleared connectedNodes during the
      // await above. Using ! would crash with TypeError in that race; a guarded
      // get() makes the close-during-subscribe path a clean no-op instead.
      const sub = this.connectedNodes.get(nodeIdStr);
      if (sub) {
        sub.subscribed = true;
        // Initialize health check timestamp — will be updated by updateReceived()
        this.lastReportTime.set(nodeIdStr, Date.now());
      }
    }

    return node;
  }

  // ----------- Cluster operations ----------------------------------------

  async invokeCommand(
    nodeIdStr: string,
    endpointId: number,
    clusterId: number,
    commandName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const node = await this.getOrConnectNode(nodeIdStr, false);
    try {
      const client = node
        .getDeviceById(EndpointNumber(endpointId))
        ?.getClusterClientById(ClusterId(clusterId));

      if (!client) {
        throw new Error(
          `Cluster 0x${clusterId.toString(16)} not found on endpoint ${endpointId} of node ${nodeIdStr}`,
        );
      }
      if (typeof client.commands[commandName] !== "function") {
        throw new Error(
          `Command "${commandName}" not found in cluster 0x${clusterId.toString(16)}`,
        );
      }

      const hasArgs = Object.keys(args).length > 0;
      return await (client.commands[commandName] as (a?: Record<string, unknown>) => Promise<unknown>)(
        hasArgs ? args : undefined,
      );
    } finally {
      await this.releaseIfTransient(nodeIdStr, node);
    }
  }

  async readAttribute(
    nodeIdStr: string,
    endpointId: number,
    clusterId: number,
    attributeName: string,
  ): Promise<unknown> {
    const node = await this.getOrConnectNode(nodeIdStr, false);
    try {
      const client = node
        .getDeviceById(EndpointNumber(endpointId))
        ?.getClusterClientById(ClusterId(clusterId));

      if (!client) {
        throw new Error(
          `Cluster 0x${clusterId.toString(16)} not found on endpoint ${endpointId} of node ${nodeIdStr}`,
        );
      }
      const attrClient = client.attributes[attributeName];
      if (!attrClient) {
        throw new Error(
          `Attribute "${attributeName}" not found in cluster 0x${clusterId.toString(16)}`,
        );
      }
      // Pass `true` to always fetch fresh value from the device.
      return await attrClient.get(true);
    } finally {
      await this.releaseIfTransient(nodeIdStr, node);
    }
  }

  /**
   * Read an attribute value from the local subscription cache without making
   * a network round trip. Useful for emitting initial state right after a
   * subscription is established.
   */
  async readCachedAttribute(
    nodeIdStr: string,
    endpointId: number,
    clusterId: number,
    attributeName: string,
  ): Promise<unknown> {
    const node = await this.getOrConnectNode(nodeIdStr, false);
    try {
      const client = node
        .getDeviceById(EndpointNumber(endpointId))
        ?.getClusterClientById(ClusterId(clusterId));

      if (!client) {
        throw new Error(
          `Cluster 0x${clusterId.toString(16)} not found on endpoint ${endpointId} of node ${nodeIdStr}`,
        );
      }
      const attrClient = client.attributes[attributeName];
      if (!attrClient) {
        throw new Error(
          `Attribute "${attributeName}" not found in cluster 0x${clusterId.toString(16)}`,
        );
      }
      // false = read from local cache populated by subscription, no network round trip
      return await attrClient.get(false);
    } finally {
      await this.releaseIfTransient(nodeIdStr, node);
    }
  }

  /**
   * Read Thread diagnostics from ThreadNetworkDiagnostics (cluster 0x0035, endpoint 0).
   * Reads from the local subscription cache (get(false)) — no network round trip.
   * Data is already populated by the active subscription session.
   * Color is based on min neighbor RSSI (best proxy for raw radio signal).
   */
  async readSignalStrength(nodeIdStr: string): Promise<SignalInfo> {
    const node = await this.getOrConnectNode(nodeIdStr, false);
    try {
      const ep0  = node.getDeviceById(EndpointNumber(0));
      const threadClient = ep0?.getClusterClientById(ClusterId(0x0035));
      if (!threadClient) return { type: 'unknown', level: 'unknown' };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const readAttr = async (name: string): Promise<any> => {
        if (!threadClient.attributes[name]) return undefined;
        // get(false) = read from local subscription cache, zero network I/O
        try { return await (threadClient.attributes[name] as any).get(false); } catch { return undefined; }
      };

      const [neighborTable, detachedCount, parentChanges, attachAttempts] = await Promise.all([
        readAttr('neighborTable'),
        readAttr('detachedRoleCount'),
        readAttr('parentChangeCount'),
        readAttr('attachAttemptCount'),
      ]);

      let minRssi: number | undefined;
      let avgLqi: number | undefined;
      let neighborCount: number | undefined;

      if (Array.isArray(neighborTable) && neighborTable.length > 0) {
        neighborCount = neighborTable.length;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rssis = (neighborTable.map((n: any) => n.averageRssi ?? n.lastRssi) as unknown[]).filter((r): r is number => typeof r === 'number');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lqis  = (neighborTable.map((n: any) => n.lqi) as unknown[]).filter((l): l is number => typeof l === 'number');
        minRssi = rssis.length ? rssis.reduce((a, b) => (b < a ? b : a)) : undefined;
        avgLqi  = lqis.length  ? Math.round(lqis.reduce((a, b) => a + b, 0) / lqis.length) : undefined;
      }

      const level: SignalInfo['level'] = minRssi !== undefined
        ? (minRssi >= -70 ? 'good' : minRssi >= -85 ? 'fair' : 'poor')
        : (avgLqi  !== undefined ? (avgLqi >= 180 ? 'good' : avgLqi >= 100 ? 'fair' : 'poor') : 'unknown');

      return {
        type: 'Thread',
        rssi: minRssi,
        lqi: avgLqi,
        neighborCount,
        detachedCount:  typeof detachedCount  === 'number' ? detachedCount  : undefined,
        parentChanges:  typeof parentChanges   === 'number' ? parentChanges   : undefined,
        attachAttempts: typeof attachAttempts  === 'number' ? attachAttempts  : undefined,
        level,
      };
    } finally {
      await this.releaseIfTransient(nodeIdStr, node);
    }
  }

  /**
   * Discover all endpoints and clusters of a commissioned node.
   * For each cluster, lists the available attribute names and command names
   * by inspecting the cluster client objects returned by matter.js.
   */
  async discoverDevice(nodeIdStr: string): Promise<DeviceDescription> {
    const node = await this.getOrConnectNode(nodeIdStr, false);
    try {
      return this.buildDiscovery(nodeIdStr, node);
    } finally {
      await this.releaseIfTransient(nodeIdStr, node);
    }
  }

  private buildDiscovery(nodeIdStr: string, node: PairedNode): DeviceDescription {
    const endpoints: EndpointDetail[] = [];

    // Include root endpoint (0) plus all child endpoints
    const rootDevice = node.getRootEndpoint();
    const childDevices = node.getDevices();
    const allDevices = rootDevice ? [rootDevice, ...childDevices] : childDevices;

    for (const device of allDevices) {
      const endpointId = device.number as number;
      const clusters: ClusterInfo[] = [];

      for (const client of device.getAllClusterClients()) {
        const clusterId   = client.id as number;
        const attributes  = Object.keys(client.attributes).filter(isNamed);
        const commands    = Object.keys(client.commands).filter(isNamed);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const events      = client.events ? Object.keys((client as any).events).filter(isNamed) : [];

        clusters.push({
          clusterId,
          clusterIdHex: clusterId.toString(16).toUpperCase().padStart(4, "0"),
          clusterName:  CLUSTER_NAMES[clusterId] ?? `Unknown (0x${clusterId.toString(16).padStart(4, "0")})`,
          attributes,
          commands,
          events,
        });
      }

      endpoints.push({ endpointId, clusters });
    }

    endpoints.sort((a, b) => a.endpointId - b.endpointId);
    return { nodeId: nodeIdStr, endpoints };
  }

  // ----------- Subscription management ----------------------------------

  /**
   * Register a callback that fires when any attribute on `nodeIdStr` changes.
   * Automatically enables subscription for that node the first time a handler
   * is registered.
   *
   * Supply `filter` with at least a `clusterId` to opt into selective
   * subscription (only that cluster is subscribed, saving memory).
   * If any handler has no clusterId filter the node falls back to a full
   * `subscribeAllAttributesAndEvents` for that device.
   */
  async addAttributeHandler(
    nodeIdStr: string,
    handler: AttributeChangeHandler,
    filter?: SubscriptionFilter,
  ): Promise<void> {
    this.getOrCreateHandlerSet(this.attrHandlers, nodeIdStr).add(handler);
    if (filter?.clusterId !== undefined) {
      let filterMap = this.attrHandlerFilters.get(nodeIdStr);
      if (!filterMap) { filterMap = new Map(); this.attrHandlerFilters.set(nodeIdStr, filterMap); }
      filterMap.set(handler, filter);
    }
    await this.ensureSubscribed(nodeIdStr);
  }

  removeAttributeHandler(nodeIdStr: string, handler: AttributeChangeHandler): void {
    const set = this.attrHandlers.get(nodeIdStr);
    set?.delete(handler);
    if (set?.size === 0) this.attrHandlers.delete(nodeIdStr);
    const filters = this.attrHandlerFilters.get(nodeIdStr);
    filters?.delete(handler);
    if (filters?.size === 0) this.attrHandlerFilters.delete(nodeIdStr);
    
    // Clean up connection if no handlers remain
    this.releaseIfNoHandlers(nodeIdStr);
  }

  /**
   * Register a callback that fires when any event is triggered on `nodeIdStr`.
   * Automatically enables subscription for that node the first time a handler
   * is registered.
   *
   * Supply `filter` with at least a `clusterId` to opt into selective
   * subscription.
   */
  async addEventHandler(
    nodeIdStr: string,
    handler: EventTriggeredHandler,
    filter?: SubscriptionFilter,
  ): Promise<void> {
    this.getOrCreateHandlerSet(this.eventHandlers, nodeIdStr).add(handler);
    if (filter?.clusterId !== undefined) {
      let filterMap = this.eventHandlerFilters.get(nodeIdStr);
      if (!filterMap) { filterMap = new Map(); this.eventHandlerFilters.set(nodeIdStr, filterMap); }
      filterMap.set(handler, filter);
    }
    await this.ensureSubscribed(nodeIdStr);
  }

  removeEventHandler(nodeIdStr: string, handler: EventTriggeredHandler): void {
    const set = this.eventHandlers.get(nodeIdStr);
    set?.delete(handler);
    if (set?.size === 0) this.eventHandlers.delete(nodeIdStr);
    const filters = this.eventHandlerFilters.get(nodeIdStr);
    filters?.delete(handler);
    if (filters?.size === 0) this.eventHandlerFilters.delete(nodeIdStr);
    
    // Clean up connection if no handlers remain
    this.releaseIfNoHandlers(nodeIdStr);
  }

  // ----------- Private helpers -------------------------------------------

  private requireController(): CommissioningController {
    if (!this.controller) {
      throw new Error("Matter controller not started. This is a bug.");
    }
    return this.controller;
  }

  private async ensureSubscribed(nodeIdStr: string): Promise<void> {
    if (!this.started) return;
    const existing = this.connectedNodes.get(nodeIdStr);
    if (existing?.subscribed) return;

    // If another caller is already subscribing for this node, wait for that
    // instead of sending a second Subscribe Request to the device.
    const inFlight = this.subscribingPromises.get(nodeIdStr);
    if (inFlight) return inFlight;

    const work = (async () => {
      if (existing) {
        await this.activateSubscriptions(nodeIdStr, existing.node);
        existing.subscribed = true;
      } else {
        // Not yet connected — connect WITH subscriptions
        await this.getOrConnectNode(nodeIdStr, true);
      }
    })();

    const deduped = work.finally(() => {
      this.subscribingPromises.delete(nodeIdStr);
    });
    // Attach error handler to the stored promise. Callers who await `work`
    // (not `deduped`) still see the rejection; this handler only fires if
    // no concurrent caller is waiting on it, preventing unhandled-rejection
    // errors that would crash node-red via matter.js's Unhandled class.
    deduped.catch((err) => {
      logger.debug(`Subscription setup failed for ${nodeIdStr}: ${err.message}`);
    });
    this.subscribingPromises.set(nodeIdStr, deduped);
    return work;
  }

  private async activateSubscriptions(nodeIdStr: string, node: PairedNode): Promise<void> {
    if (!this.started) return;
    if (this.canUseSelectiveSubscription(nodeIdStr)) {
      await this.activateSelectiveSubscription(nodeIdStr, node);
    } else {
      await this.activateFullSubscription(nodeIdStr, node);
    }
  }

  /**
   * Returns true when every registered handler for `nodeIdStr` supplies a
   * clusterId filter, meaning we can use a selective Matter Subscribe Request
   * (one message, specific cluster paths) instead of subscribing to the whole
   * device. This cuts per-device cached data from ~15 MB to ~1-2 MB.
   */
  private canUseSelectiveSubscription(nodeIdStr: string): boolean {
    const attrHandlers = this.attrHandlers.get(nodeIdStr);
    const evtHandlers  = this.eventHandlers.get(nodeIdStr);
    const attrFilters  = this.attrHandlerFilters.get(nodeIdStr);
    const evtFilters   = this.eventHandlerFilters.get(nodeIdStr);

    if (attrHandlers?.size) {
      for (const h of attrHandlers) {
        if (attrFilters?.get(h)?.clusterId === undefined) return false;
      }
    }
    if (evtHandlers?.size) {
      for (const h of evtHandlers) {
        if (evtFilters?.get(h)?.clusterId === undefined) return false;
      }
    }
    return true;
  }

  /**
   * Selective subscription using InteractionClient.subscribeMultipleAttributesAndEvents().
   * Sends a single Matter Subscribe Request listing only the specific cluster IDs
   * that have registered handlers. The device pushes only those clusters, so
   * matter.js only caches that data — dramatically less memory than full subscription.
   *
   * Falls back to full subscription if getInteractionClient() fails.
   */
  private async activateSelectiveSubscription(nodeIdStr: string, node: PairedNode): Promise<void> {
    // Collect the unique cluster IDs across all attribute and event handler filters.
    const attrClusterIds = new Set<number>();
    const evtClusterIds  = new Set<number>();

    for (const filter of (this.attrHandlerFilters.get(nodeIdStr)?.values() ?? [])) {
      if (filter.clusterId !== undefined) attrClusterIds.add(filter.clusterId);
    }
    for (const filter of (this.eventHandlerFilters.get(nodeIdStr)?.values() ?? [])) {
      if (filter.clusterId !== undefined) evtClusterIds.add(filter.clusterId);
    }

    if (attrClusterIds.size === 0 && evtClusterIds.size === 0) {
      // Degenerate: no handlers at all — nothing to subscribe to.
      return;
    }

    let interactionClient: ReturnType<PairedNode["getInteractionClient"]>;
    try {
      interactionClient = node.getInteractionClient();
    } catch (e) {
      logger.warn(`getInteractionClient() failed for node ${nodeIdStr}, falling back to full subscription: ${e}`);
      await this.activateFullSubscription(nodeIdStr, node);
      return;
    }

    const attributePaths = [...attrClusterIds].map(clusterId => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clusterId: ClusterId(clusterId) as any,
    }));
    const eventPaths = [...evtClusterIds].map(clusterId => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clusterId: ClusterId(clusterId) as any,
    }));

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (interactionClient as any).subscribeMultipleAttributesAndEvents({
        attributes: attributePaths,
        events:     eventPaths,
        minIntervalFloorSeconds:   30,
        maxIntervalCeilingSeconds: 180,  // Reduced from 300s for faster recovery
        attributeListener: this.makeAttrListener(nodeIdStr),
        eventListener:     this.makeEvtListener(nodeIdStr),
        updateTimeoutHandler: this.makeUpdateTimeoutHandler(nodeIdStr),
        updateReceived: () => { this.lastReportTime.set(nodeIdStr, Date.now()); },
      });
    } catch (e) {
      logger.warn(`Selective subscription failed for node ${nodeIdStr}, falling back to full: ${e}`);
      await this.activateFullSubscription(nodeIdStr, node);
      return;
    }

    // Setup state handler after successful subscription. If this fails, the
    // subscription is still active and the health check will monitor the node.
    try {
      this.setupStateHandler(nodeIdStr, node);
      logger.info(`Selectively subscribed to clusters [${[...attrClusterIds].map(c => '0x' + c.toString(16)).join(', ')}] for node ${nodeIdStr}`);
    } catch (e) {
      logger.warn(`setupStateHandler failed for node ${nodeIdStr}: ${e}`);
    }
  }

  /**
   * Subscribes to all attributes and events on the device.
   *
   * NOTE: In matter.js 0.17, `subscribeAllAttributesAndEvents()` ignores passed
   * callbacks and does nothing when `autoSubscribe=false` (the underscore prefix
   * on `_options` marks the parameter as intentionally unused). We therefore use
   * `subscribeMultipleAttributesAndEvents` with wildcard paths (empty objects =
   * all endpoints/clusters) so the same proven code path handles both modes.
   */
  private async activateFullSubscription(nodeIdStr: string, node: PairedNode): Promise<void> {
    // getInteractionClient() returns the private field set at construction time
    // and never throws. We intentionally let any unexpected error propagate so
    // the caller does NOT mark subscribed=true on failure.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const interactionClient = node.getInteractionClient() as any;

    await interactionClient.subscribeMultipleAttributesAndEvents({
      attributes: [{}],   // wildcard — all attributes on all endpoints/clusters
      events:     [{}],   // wildcard — all events
      minIntervalFloorSeconds:   30,
      maxIntervalCeilingSeconds: 180,  // Reduced from 300s for faster recovery
      attributeListener: this.makeAttrListener(nodeIdStr),
      eventListener:     this.makeEvtListener(nodeIdStr),
      updateTimeoutHandler: this.makeUpdateTimeoutHandler(nodeIdStr),
      updateReceived: () => { this.lastReportTime.set(nodeIdStr, Date.now()); },
    });

    // Setup state handler after successful subscription. If this fails, the
    // subscription is still active and the health check will monitor the node.
    try {
      this.setupStateHandler(nodeIdStr, node);
      logger.info(`Subscribed to all attributes and events for node ${nodeIdStr}`);
    } catch (e) {
      logger.warn(`setupStateHandler failed for node ${nodeIdStr}: ${e}`);
    }
  }

  /**
   * Returns a callback for matter.js `updateTimeoutHandler`. This fires when
   * the device stops sending reports within `maxIntervalCeiling` seconds —
   * a silent subscription death that does NOT trigger `stateChanged`. Without
   * this handler, events simply stop arriving with no error logged anywhere.
   *
   * On timeout we drop the cached node entry and reconnect, mirroring the
   * logic already used for an explicit Disconnected → Connected cycle.
   */
  private makeUpdateTimeoutHandler(nodeIdStr: string): () => void {
    return () => {
      logger.warn(`Subscription heartbeat timed out for node ${nodeIdStr} — resubscribing`);
      const entry = this.connectedNodes.get(nodeIdStr);
      if (!entry) return;
      // Detach the stateChanged listener so setupStateHandler() on the next
      // activateSubscriptions() call starts clean.
      const prevStateHandler = this.stateHandlers.get(nodeIdStr);
      if (prevStateHandler) {
        entry.node.events.stateChanged.off(prevStateHandler);
        this.stateHandlers.delete(nodeIdStr);
        this.stateHandlerNodes.delete(nodeIdStr);
      }
      // Drop the stale entry so getOrConnectNode() opens a fresh CASE session.
      this.connectedNodes.delete(nodeIdStr);
      this.lastReportTime.delete(nodeIdStr);
      if (this.hasActiveHandlers(nodeIdStr)) {
        this.getOrConnectNode(nodeIdStr, true).catch(e =>
          logger.warn(`Re-subscribe after timeout failed for ${nodeIdStr}: ${e}`),
        );
      }
    };
  }

  /**
   * Starts the periodic health check that detects stale subscriptions.
   * Runs every 60 seconds to catch devices with poor connectivity (Thread sensors
   * with RSSI < -90 dBm) that silently stop sending reports without triggering
   * Matter.js state changes. More aggressive than updateTimeoutHandler for faster
   * recovery on intermittent connections.
   */
  private startHealthCheck(): void {
    // Clear any existing interval first (e.g. after hot-redeploy)
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 60_000); // Check every 60 seconds
  }

  /**
   * Health check logic: for each subscribed node, verify we've received a report
   * within the expected maxInterval window + grace period. If not, proactively
   * reconnect even if Matter.js still thinks the node is "Connected".
   * 
   * Iterates over all nodes with active handlers (not just connectedNodes) to
   * ensure nodes that failed reconnection are retried on every health check cycle.
   */
  private performHealthCheck(): void {
    // Guard against health check running during/after shutdown
    if (!this.started) return;

    const now = Date.now();
    const maxSilence = 180_000 + 60_000; // maxIntervalCeiling (180s) + 60s grace = 240s

    // Build set of all nodeIds with active handlers (these need event delivery).
    // Use a Set to deduplicate nodes that appear in both attrHandlers and eventHandlers.
    const nodesWithHandlers = new Set<string>([
      ...this.attrHandlers.keys(),
      ...this.eventHandlers.keys(),
    ]);

    for (const nodeIdStr of nodesWithHandlers) {
      const entry = this.connectedNodes.get(nodeIdStr);
      
      // If not connected, try to establish a fresh subscription.
      // Note: since stateChanged(Disconnected) now immediately evicts the
      // connectedNodes entry, a truly-disconnected node will have !entry.
      // The only case where entry exists with subscribed=false is the narrow
      // window between ctrl.connectNode() completing and activateSubscriptions()
      // finishing — in that case we must NOT disrupt the in-progress setup.
      if (!entry || !entry.subscribed) {
        // Skip if connection or subscription already in progress
        if (this.connectingPromises.has(nodeIdStr) || this.subscribingPromises.has(nodeIdStr)) {
          continue;
        }

        // Skip the in-progress window: entry present but subscribed=false means
        // connectWork completed but activateSubscriptions hasn't finished yet.
        // Evicting here would cause a double-subscription; let it complete.
        if (entry && !entry.subscribed) {
          continue;
        }

        // Evict the stateHandler before starting the reconnect so that if
        // matter.js fires stateChanged(Connected) on the old node while our
        // getOrConnectNode() is already in-flight, the old handler's Connected
        // branch does not race us and send a second Subscribe Request.
        // setupStateHandler() called inside activateSubscriptions() will install
        // a fresh handler once the new subscription is established.
        const sh = this.stateHandlers.get(nodeIdStr);
        if (sh) {
          const nodeRef = this.stateHandlerNodes.get(nodeIdStr);
          if (nodeRef) nodeRef.events.stateChanged.off(sh);
          this.stateHandlers.delete(nodeIdStr);
          this.stateHandlerNodes.delete(nodeIdStr);
        }

        logger.info(`Health check: node ${nodeIdStr} not connected, attempting reconnection`);
        this.getOrConnectNode(nodeIdStr, true).catch(e =>
          logger.debug(`Health check reconnect attempt failed for ${nodeIdStr}: ${e}`)
        );
        continue;
      }

      // Node is subscribed - check if reports are arriving
      const lastReport = this.lastReportTime.get(nodeIdStr);
      if (!lastReport) {
        // Subscription just started, no reports yet — record now as baseline
        this.lastReportTime.set(nodeIdStr, now);
        continue;
      }

      const silenceDuration = now - lastReport;
      if (silenceDuration > maxSilence) {
        // Skip if connection or subscription already in progress
        if (this.connectingPromises.has(nodeIdStr) || this.subscribingPromises.has(nodeIdStr)) {
          logger.debug(`Health check: skipping ${nodeIdStr}, reconnection already in progress`);
          continue;
        }

        logger.warn(
          `Health check: node ${nodeIdStr} silent for ${Math.round(silenceDuration / 1000)}s ` +
          `(threshold ${maxSilence / 1000}s) — triggering reconnect`
        );

        // Detach the stateChanged listener before evicting the entry so the
        // old handler does not fire on the evicted (now-stale) node reference.
        const prevStateHandler = this.stateHandlers.get(nodeIdStr);
        if (prevStateHandler) {
          entry.node.events.stateChanged.off(prevStateHandler);
          this.stateHandlers.delete(nodeIdStr);
          this.stateHandlerNodes.delete(nodeIdStr);
        }

        // Drop the stale PairedNode entry so getOrConnectNode() opens a fresh
        // CASE session with updated mDNS discovery (critical for Thread devices
        // that may have changed IPv6 addresses).
        this.connectedNodes.delete(nodeIdStr);
        this.lastReportTime.delete(nodeIdStr);

        // Attempt reconnection — if this fails, next health check will retry
        // because we iterate over nodesWithHandlers, not connectedNodes.
        this.getOrConnectNode(nodeIdStr, true).catch(e =>
          logger.debug(`Health check reconnect failed for ${nodeIdStr}: ${e}`)
        );
      }
    }
  }

  /**
   * Builds the attribute-change dispatcher closure for `nodeIdStr`.
   * Extracted so both selective and full subscription paths share identical logic.
   * The returned function is stored by the matter.js subscription and lives for
   * the connection lifetime — no per-event allocation beyond the event object itself.
   */
  private makeAttrListener(nodeIdStr: string) {
    return (data: { path: { endpointId: number; clusterId: number; attributeName: string }; value: unknown }) => {
      // Update health check timestamp - defensive update even though updateReceived
      // callback should also fire. This ensures we track activity even if callback fails.
      this.lastReportTime.set(nodeIdStr, Date.now());
      
      const handlers = this.attrHandlers.get(nodeIdStr);
      if (!handlers?.size) return;
      const filters = this.attrHandlerFilters.get(nodeIdStr);
      // Lazy: build the event object (and call new Date()) only on the first
      // handler that passes its filter. If all handlers filter this update out
      // — common in full-subscription mode — we skip all allocation entirely.
      let event: AttributeChangedEvent | undefined;
      for (const h of handlers) {
        const f = filters?.get(h);
        if (f) {
          if (f.clusterId     !== undefined && f.clusterId     !== data.path.clusterId)     continue;
          if (f.endpointId    !== undefined && f.endpointId    !== data.path.endpointId)    continue;
          if (f.attributeName !== undefined && f.attributeName !== data.path.attributeName) continue;
        }
        event ??= {
          nodeId: nodeIdStr,
          endpointId: data.path.endpointId,
          clusterId: data.path.clusterId,
          clusterName: getClusterName(data.path.clusterId),
          attributeName: data.path.attributeName,
          value: data.value,
          timestamp: new Date().toISOString(),
        };
        try { h(event); } catch { /* keep other handlers running */ }
      }
    };
  }

  /**
   * Builds the event-triggered dispatcher closure for `nodeIdStr`.
   * Extracted so both selective and full subscription paths share identical logic.
   */
  private makeEvtListener(nodeIdStr: string) {
    return (data: { path: { endpointId: number; clusterId: number; eventName: string }; events: unknown[] }) => {
      // Update health check timestamp - defensive update even though updateReceived
      // callback should also fire. This ensures we track activity even if callback fails.
      this.lastReportTime.set(nodeIdStr, Date.now());
      
      const handlers = this.eventHandlers.get(nodeIdStr);
      if (!handlers?.size) return;
      const filters = this.eventHandlerFilters.get(nodeIdStr);
      // Lazy: build the event object and copy data.events only on the first
      // handler that passes its filter, avoiding [...] allocation for filtered events.
      let event: EventTriggeredEvent | undefined;
      for (const h of handlers) {
        const f = filters?.get(h);
        if (f) {
          if (f.clusterId  !== undefined && f.clusterId  !== data.path.clusterId)  continue;
          if (f.endpointId !== undefined && f.endpointId !== data.path.endpointId) continue;
          if (f.eventName  !== undefined && f.eventName  !== data.path.eventName)  continue;
        }
        event ??= {
          nodeId: nodeIdStr,
          endpointId: data.path.endpointId,
          clusterId: data.path.clusterId,
          clusterName: getClusterName(data.path.clusterId),
          eventName: data.path.eventName,
          events: [...data.events],   // shallow copy — guard against SDK buffer reuse
          timestamp: new Date().toISOString(),
        };
        try { h(event); } catch { /* keep other handlers running */ }
      }
    };
  }

  /**
   * Attach the stateChanged listener that re-subscribes on reconnect.
   * Extracted so both full and selective subscription paths share the same logic.
   *
   * Reconnection strategy
   * ─────────────────────
   * On Disconnected/Reconnecting we IMMEDIATELY evict the connectedNodes entry
   * so that every subsequent reconnect path — whether it arrives via:
   *   (a) stateChanged(Connected) fired by matter.js auto-reconnect, OR
   *   (b) the periodic health check (when matter.js never fires Connected), OR
   *   (c) updateTimeoutHandler (subscription heartbeat timeout)
   * — is forced to call ctrl.connectNode() for a fresh CASE session.
   *
   * Without the eviction, getOrConnectNode() finds the stale entry and calls
   * activateSubscriptions() on the disconnected PairedNode whose InteractionClient
   * is bound to the dead session.  Matter.js does not throw — the subscribe call
   * "succeeds" but no reports ever arrive, leaving the node silently dead.
   *
   * Self-detach guard
   * ─────────────────
   * The guard uses stateHandlers.get(nodeIdStr) !== stateHandler instead of
   * !connectedNodes.get(nodeIdStr).  The old guard checked the connectedNodes map,
   * but we now delete the entry on Disconnect, which would have caused the handler
   * to self-detach before it could see the subsequent Connected event.
   */
  private setupStateHandler(nodeIdStr: string, node: PairedNode): void {
    // Remove any previous listener first — activateSubscriptions may be called
    // again on each reconnect cycle.
    const prevStateHandler = this.stateHandlers.get(nodeIdStr);
    if (prevStateHandler) node.events.stateChanged.off(prevStateHandler);

    let wasDisconnected = false;
    const stateHandler = (state: NodeStates) => {
      // Self-detach if this handler has been superseded (replaced by a newer
      // setupStateHandler call or explicitly removed by close()/removeDevice()).
      // We intentionally do NOT check connectedNodes here — we delete that entry
      // on Disconnect and need the handler to survive until Connected fires.
      if (this.stateHandlers.get(nodeIdStr) !== stateHandler) {
        node.events.stateChanged.off(stateHandler);
        return;
      }

      if (state === NodeStates.Disconnected || state === NodeStates.Reconnecting) {
        wasDisconnected = true;
        // Evict the stale PairedNode entry immediately so every downstream
        // reconnect path (Connected branch below, health check, timeout handler)
        // is forced through ctrl.connectNode() for a fresh CASE session.
        // Keeping only subscribed=false here was the root cause of the bug:
        // getOrConnectNode() would find the stale entry and call
        // activateSubscriptions() on the dead node, silently failing forever.
        this.connectedNodes.delete(nodeIdStr);
        this.lastReportTime.delete(nodeIdStr);
        // Keep node reference in stateHandlerNodes so close() can still call
        // .off(handler) even though connectedNodes no longer holds the entry.
        this.stateHandlerNodes.set(nodeIdStr, node);
        logger.info(`Node ${nodeIdStr} ${NodeStates[state]} — evicted stale connection, will reconnect when available`);

      } else if (state === NodeStates.Connected && wasDisconnected) {
        wasDisconnected = false;
        if (this.hasActiveHandlers(nodeIdStr)) {
          logger.info(`Node ${nodeIdStr} reconnected — re-subscribing to attributes and events`);
          // Self-detach BEFORE the async reconnect so setupStateHandler() called
          // from inside the new subscription starts with a clean stateHandlers
          // entry (no stale prevStateHandler to .off() on the wrong PairedNode).
          node.events.stateChanged.off(stateHandler);
          this.stateHandlers.delete(nodeIdStr);
          this.stateHandlerNodes.delete(nodeIdStr);
          // connectedNodes was already evicted on Disconnect — no stale entry to
          // worry about.  getOrConnectNode() will call ctrl.connectNode() for a
          // fresh mDNS-discovered CASE session before sending the Subscribe Request.
          this.getOrConnectNode(nodeIdStr, true).catch(e =>
            logger.warn(`Re-subscribe after reconnect failed for ${nodeIdStr}: ${e}`),
          );
        }
      }
    };
    node.events.stateChanged.on(stateHandler);
    this.stateHandlers.set(nodeIdStr, stateHandler);
    // Clear any stale evicted-node reference — the subscription is now active
    // so connectedNodes holds the current entry.
    this.stateHandlerNodes.delete(nodeIdStr);
  }

  // ----------- Private helpers (registry & storage) -----------------------

  /**
   * Deletes storage cache files that belong to nodeIds which are no longer in
   * the registry (decommissioned devices). Called once at startup before
   * matter.js loads the cache into memory, so stale data never occupies heap.
   *
   * Safe: only removes files matching `nodes.{nodeId}.*` where nodeId is not
   * in the active registry. Commissioning data (fabrics.*, sessions.*, etc.)
   * is left untouched.
   */
  private async cleanStaleNodeCache(): Promise<void> {
    const storageDir = join(this.storagePath, "node-red-matter");
    let files: string[];
    try {
      files = await readdir(storageDir);
    } catch {
      return; // directory doesn't exist yet — nothing to clean
    }

    const activeNodeIds = new Set(Object.keys(this.registry));
    const toDelete: string[] = [];
    const staleIds = new Set<string>();

    for (const file of files) {
      // Match attribute/state files for a specific node: nodes.{nodeId}.*
      const m = file.match(/^nodes\.(\d+)\./);
      if (m && !activeNodeIds.has(m[1])) {
        toDelete.push(file);
        staleIds.add(m[1]);
      }
    }

    if (toDelete.length === 0) return;

    await Promise.all(
      toDelete.map(f => unlink(join(storageDir, f)).catch(() => { /* ignore race-condition deletes */ })),
    );
    logger.info(
      `Cleaned ${toDelete.length} stale cache file(s) for ${staleIds.size} decommissioned node(s): ${[...staleIds].join(", ")}`,
    );
  }

  // ----------- Device registry (public API) --------------------------------

  /**
   * Returns the persisted registry of commissioned devices with their discovery data.
   * Used by the Node-RED admin UI to populate cascading dropdowns.
   */
  getRegistry(): DeviceRegistry {
    return this.registry;
  }

  /**
   * Decommissions a node from the Matter fabric and removes it from the local
   * registry.
   *
   * @param nodeIdStr  Decimal node ID string
   * @param force      When true, skips fabric-level decommissioning and only
   *                   erases local storage (use when the device is unreachable).
   *                   Default: false (attempts proper decommissioning first).
   */
  async removeDevice(nodeIdStr: string, force = false): Promise<void> {
    await this.start();
    const ctrl = this.requireController();
    const nodeId = NodeId(BigInt(nodeIdStr));

    // Wait for any in-flight connections to complete before removing.
    // If we just delete the promise without awaiting, the async work continues
    // and could add the node back to connectedNodes after we've cleaned it up.
    const connectingPromise = this.connectingPromises.get(nodeIdStr);
    if (connectingPromise) {
      await connectingPromise.catch(() => {/* ignore connection errors during removal */});
    }
    const subscribingPromise = this.subscribingPromises.get(nodeIdStr);
    if (subscribingPromise) {
      await subscribingPromise.catch(() => {/* ignore subscription errors during removal */});
    }

    // Clean up any active subscriptions / handlers before removing
    const existingEntry = this.connectedNodes.get(nodeIdStr);
    const existingStateHandler = this.stateHandlers.get(nodeIdStr);
    if (existingStateHandler) {
      // Detach from the connected node if present; otherwise fall back to the
      // evicted-node reference kept in stateHandlerNodes (Disconnected state).
      const nodeRef = existingEntry?.node ?? this.stateHandlerNodes.get(nodeIdStr);
      if (nodeRef) nodeRef.events.stateChanged.off(existingStateHandler);
    }
    this.stateHandlers.delete(nodeIdStr);
    this.stateHandlerNodes.delete(nodeIdStr);
    this.connectedNodes.delete(nodeIdStr);
    this.lastReportTime.delete(nodeIdStr);
    this.attrHandlers.delete(nodeIdStr);
    this.eventHandlers.delete(nodeIdStr);
    this.attrHandlerFilters.delete(nodeIdStr);
    this.eventHandlerFilters.delete(nodeIdStr);
    this.connectingPromises.delete(nodeIdStr);
    this.subscribingPromises.delete(nodeIdStr);

    // tryDecommissioning = !force: properly removes the fabric entry on the
    // device when reachable; falls back to local-only removal on error.
    await ctrl.removeNode(nodeId, !force);

    // Remove from registry and persist
    delete this.registry[nodeIdStr];
    this.saveRegistry();
    logger.info(`Removed device ${nodeIdStr} (force=${force})`);
  }

  /**
   * Rename a device in the registry without reconnecting.
   */
  renameDevice(nodeIdStr: string, newLabel: string): void {
    const entry = this.registry[nodeIdStr];
    if (!entry) throw new Error(`Device ${nodeIdStr} not found in registry`);
    entry.label = newLabel.trim();
    this.saveRegistry();
    logger.info(`Renamed device ${nodeIdStr} to "${entry.label}"`);
  }

  /**
   * Re-discover all registered devices — forces matter.js to reconnect via
   * mDNS and refresh its internal peer address cache. Useful after a Thread
   * Border Router (e.g. HomePod) moves and all device IPv6 addresses change.
   *
   * Nodes that have active attribute/event subscriptions are automatically
   * re-subscribed after reconnection.
   */
  async rediscoverAll(): Promise<void> {
    const nodeIds = Object.keys(this.registry);
    logger.info(`Rediscovering ${nodeIds.length} device(s)…`);

    await Promise.allSettled(nodeIds.map(async (nodeIdStr) => {
      // Drop our cached connection so getOrConnectNode creates a fresh one.
      // matter.js will perform operational discovery (mDNS) to find the new
      // address on the next connectNode() call.
      const entry = this.connectedNodes.get(nodeIdStr);
      const prevStateHandler = this.stateHandlers.get(nodeIdStr);
      if (prevStateHandler) {
        const nodeRef = entry?.node ?? this.stateHandlerNodes.get(nodeIdStr);
        if (nodeRef) nodeRef.events.stateChanged.off(prevStateHandler);
      }
      this.stateHandlers.delete(nodeIdStr);
      this.stateHandlerNodes.delete(nodeIdStr);
      this.connectedNodes.delete(nodeIdStr);
      this.lastReportTime.delete(nodeIdStr);
      this.connectingPromises.delete(nodeIdStr);
      this.subscribingPromises.delete(nodeIdStr);

      const hasHandlers = this.hasActiveHandlers(nodeIdStr);

      try {
        // withSubscription=true re-subscribes nodes that had active handlers;
        // withSubscription=false just re-establishes the connection.
        await this.getOrConnectNode(nodeIdStr, hasHandlers);
        // Preserve the existing label — the user may have renamed the device.
        const existingLabel = this.registry[nodeIdStr]?.label;
        await this.registerDevice(nodeIdStr, existingLabel);
        logger.info(`Rediscovered node ${nodeIdStr}`);
      } catch (e) {
        logger.warn(`Rediscover failed for node ${nodeIdStr}: ${e}`);
      }
    }));

    logger.info("Rediscovery complete");
  }

  /**
   * Discovers a commissioned device and persists the result in the registry.
   * Called automatically after commissioning; can also be triggered manually.
   *
   * @param labelOverride  When provided, uses this as the registry label instead of
   *                       the productName read from the device.
   */
  async registerDevice(nodeIdStr: string, labelOverride?: string): Promise<void> {
    const node = await this.getOrConnectNode(nodeIdStr, false);
    try {
      let label: string;
      if (labelOverride && labelOverride.trim()) {
        label = labelOverride.trim();
      } else {
        // Try to read productName from BasicInformation cluster (cluster 0x0028).
        label = "Device";
        try {
          const rootEp = node.getRootEndpoint();
          const biClient = rootEp?.getClusterClientById(ClusterId(0x0028));
          if (biClient?.attributes?.["productName"]) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const name = await (biClient.attributes["productName"] as any).get(false);
            if (name) label = String(name);
          }
        } catch { /* fall back to default label */ }
      }

      // Reuse the already-connected node — avoids a second getOrConnectNode call.
      const discovery = this.buildDiscovery(nodeIdStr, node);
      this.registry[nodeIdStr] = { label, nodeId: nodeIdStr, discoveredAt: new Date().toISOString(), discovery };
      this.saveRegistry();
      logger.info(`Registered device ${nodeIdStr} as "${label}"`);
    } finally {
      // Release the CASE session if no subscription handler is active for this
      // node. Without this, commission() and rediscoverAll() leave a live
      // connection open in RAM indefinitely even when no flow subscribes to it.
      await this.releaseIfTransient(nodeIdStr, node);
    }
  }

  private loadRegistry(): void {
    try {
      const data = readFileSync(this.registryPath, "utf8");
      this.registry = JSON.parse(data) as DeviceRegistry;
      // Migrate: strip pure-numeric attribute/command/event keys left by older versions
      let migrated = false;
      for (const entry of Object.values(this.registry)) {
        for (const ep of entry.discovery?.endpoints ?? []) {
          for (const cl of ep.clusters ?? []) {
            const aLen = cl.attributes.length;
            const cLen = cl.commands.length;
            const eLen = cl.events.length;
            cl.attributes = cl.attributes.filter(isNamed);
            cl.commands   = cl.commands.filter(isNamed);
            cl.events     = cl.events.filter(isNamed);
            if (cl.attributes.length !== aLen || cl.commands.length !== cLen || cl.events.length !== eLen) migrated = true;
          }
        }
      }
      if (migrated) {
        logger.info("Migrated device registry — removed numeric attribute/command/event keys");
        this.saveRegistry();
      }
      logger.info(`Loaded device registry — ${Object.keys(this.registry).length} entries`);
    } catch {
      this.registry = {};
    }
  }

  private saveRegistry(): void {
    // Async write — never blocks the event loop (critical on Pi with slow SD card).
    writeFile(this.registryPath, JSON.stringify(this.registry), "utf8")
      .catch(e => logger.warn(`Failed to save device registry: ${e}`));
  }

  private getOrCreateHandlerSet<T>(
    map: Map<string, Set<T>>,
    key: string,
  ): Set<T> {
    let set = map.get(key);
    if (!set) { set = new Set<T>(); map.set(key, set); }
    return set;
  }
}
