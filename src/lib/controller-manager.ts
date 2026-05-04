/**
 * ControllerManager — wraps the matter.js CommissioningController in a
 * Node-RED-friendly singleton (one per storage path).
 *
 * Import order matters: @matter/nodejs MUST be imported first so that
 * the Node.js native crypto / network / storage implementations are
 * registered before any Matter object is created.
 */
import "@matter/nodejs";

import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CommissioningController } from "@project-chip/matter.js";
import { NodeStates } from "@project-chip/matter.js/device";
import type { CommissioningControllerNodeOptions, PairedNode } from "@project-chip/matter.js/device";
import { Logger } from "@matter/general";
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

export interface AttributeChangedEvent {
  nodeId: string;
  endpointId: number;
  clusterId: number;
  attributeName: string;
  value: unknown;
  /** ISO-8601 string — avoids heap-allocating a Date object in the hot callback path. */
  timestamp: string;
}

export interface EventTriggeredEvent {
  nodeId: string;
  endpointId: number;
  clusterId: number;
  eventName: string;
  events: unknown[];
  /** ISO-8601 string — avoids heap-allocating a Date object in the hot callback path. */
  timestamp: string;
}

export type AttributeChangeHandler = (event: AttributeChangedEvent) => void;
export type EventTriggeredHandler = (event: EventTriggeredEvent) => void;

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
  /**
   * Per-node subscription lock. If subscribeAllAttributesAndEvents() is already
   * in progress for a node, concurrent callers await the same promise instead of
   * each sending their own Subscribe Request to the device.
   */
  private readonly subscribingPromises = new Map<string, Promise<void>>();

  /**
   * Per-node stateChanged listeners that re-subscribe after the device
   * reconnects following an outage. Kept here so they can be cleanly
   * detached in close() and removeDevice().
   */
  private readonly stateHandlers = new Map<string, (state: NodeStates) => void>();

  /** Persisted registry of commissioned devices with their discovery data */
  private registry: DeviceRegistry = {};
  private registryPath = "";

  private constructor(
    private readonly storagePath: string,
    private readonly port: number,
  ) {}

  // ----------- Singleton access ------------------------------------------

  static getInstance(storagePath: string, port: number): ControllerManager {
    if (!instances.has(storagePath)) {
      instances.set(storagePath, new ControllerManager(storagePath, port));
    }
    return instances.get(storagePath)!;
  }

  static removeInstance(storagePath: string): void {
    instances.delete(storagePath);
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

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Environment } = require("@matter/general") as typeof import("@matter/general");
    const env = Environment.default;
    env.vars.set("storage.path", this.storagePath);

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

    await this.controller.start();
    this.started = true;
    logger.info(`Matter controller started — storage: ${this.storagePath}`);
  }

  async close(): Promise<void> {
    if (!this.started) return;
    // Detach stateChanged listeners before clearing the node map so we still
    // have access to entry.node for the .off() call.
    for (const [nodeIdStr, entry] of this.connectedNodes) {
      const h = this.stateHandlers.get(nodeIdStr);
      if (h) entry.node.events.stateChanged.off(h);
    }
    this.stateHandlers.clear();
    this.connectedNodes.clear();
    this.attrHandlers.clear();
    this.eventHandlers.clear();
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

    // Always connect without autoSubscribe — we manage subscriptions explicitly
    // via subscribeAllAttributesAndEvents() so it works correctly for both
    // always-on and sleepy/ICD (Thread) devices.
    const connectOptions: CommissioningControllerNodeOptions = {
      autoSubscribe: false,
    };

    const node = await ctrl.connectNode(nodeId, connectOptions);

    // Wait for local initialization (uses previously cached data if available).
    if (!node.initialized) {
      await node.events.initialized;
    }

    this.connectedNodes.set(nodeIdStr, { node, subscribed: false });

    if (withSubscription) {
      await this.activateSubscriptions(nodeIdStr, node);
      this.connectedNodes.get(nodeIdStr)!.subscribed = true;
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
  }

  async readAttribute(
    nodeIdStr: string,
    endpointId: number,
    clusterId: number,
    attributeName: string,
  ): Promise<unknown> {
    const node = await this.getOrConnectNode(nodeIdStr, false);
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
  }

  /**
   * Discover all endpoints and clusters of a commissioned node.
   * For each cluster, lists the available attribute names and command names
   * by inspecting the cluster client objects returned by matter.js.
   */
  async discoverDevice(nodeIdStr: string): Promise<DeviceDescription> {
    const node = await this.getOrConnectNode(nodeIdStr, false);
    return this.buildDiscovery(nodeIdStr, node);
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
        const attributes  = Object.keys(client.attributes);
        const commands    = Object.keys(client.commands);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const events      = client.events ? Object.keys((client as any).events) : [];

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
   */
  async addAttributeHandler(
    nodeIdStr: string,
    handler: AttributeChangeHandler,
  ): Promise<void> {
    this.getOrCreateHandlerSet(this.attrHandlers, nodeIdStr).add(handler);
    await this.ensureSubscribed(nodeIdStr);
  }

  removeAttributeHandler(nodeIdStr: string, handler: AttributeChangeHandler): void {
    const set = this.attrHandlers.get(nodeIdStr);
    set?.delete(handler);
    if (set?.size === 0) this.attrHandlers.delete(nodeIdStr);
  }

  /**
   * Register a callback that fires when any event is triggered on `nodeIdStr`.
   * Automatically enables subscription for that node the first time a handler
   * is registered.
   */
  async addEventHandler(
    nodeIdStr: string,
    handler: EventTriggeredHandler,
  ): Promise<void> {
    this.getOrCreateHandlerSet(this.eventHandlers, nodeIdStr).add(handler);
    await this.ensureSubscribed(nodeIdStr);
  }

  removeEventHandler(nodeIdStr: string, handler: EventTriggeredHandler): void {
    const set = this.eventHandlers.get(nodeIdStr);
    set?.delete(handler);
    if (set?.size === 0) this.eventHandlers.delete(nodeIdStr);
  }

  // ----------- Private helpers -------------------------------------------

  private requireController(): CommissioningController {
    if (!this.controller) {
      throw new Error("Matter controller not started. This is a bug.");
    }
    return this.controller;
  }

  private async ensureSubscribed(nodeIdStr: string): Promise<void> {
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

    this.subscribingPromises.set(nodeIdStr, work.finally(() => {
      this.subscribingPromises.delete(nodeIdStr);
    }));
    return work;
  }

  private async activateSubscriptions(nodeIdStr: string, node: PairedNode): Promise<void> {
    // Pass callbacks directly — node.events.attributeChanged/eventTriggered are only
    // emitted by the internal autoSubscribe path, NOT when calling subscribeAllAttributesAndEvents
    // explicitly. Passing callbacks here is the correct way to receive updates.
    //
    // Devices can be slow to accept subscriptions right after (re)connecting — e.g. immediately
    // after commissioning reboot or reconnect. Retry once after a short delay before giving up.
    await node.subscribeAllAttributesAndEvents({
      ignoreInitialTriggers: true,
      attributeChangedCallback: (data) => {
        const handlers = this.attrHandlers.get(nodeIdStr);
        if (!handlers?.size) return;
        // Use ISO string — string primitive avoids a heap-allocated Date object
        // on every attribute change (reduces GC pressure on Pi).
        const event: AttributeChangedEvent = {
          nodeId: nodeIdStr,
          endpointId: data.path.endpointId,
          clusterId: data.path.clusterId,
          attributeName: data.path.attributeName,
          value: data.value,
          timestamp: new Date().toISOString(),
        };
        for (const h of handlers) {
          try { h(event); } catch { /* keep other handlers running */ }
        }
      },
      eventTriggeredCallback: (data) => {
        const handlers = this.eventHandlers.get(nodeIdStr);
        if (!handlers?.size) return;
        const event: EventTriggeredEvent = {
          nodeId: nodeIdStr,
          endpointId: data.path.endpointId,
          clusterId: data.path.clusterId,
          eventName: data.path.eventName,
          events: [...data.events],
          timestamp: new Date().toISOString(),
        };
        for (const h of handlers) {
          try { h(event); } catch { /* keep other handlers running */ }
        }
      },
    });

    // -------------------------------------------------------------------------
    // Re-subscription after device reconnect
    // -------------------------------------------------------------------------
    // subscribeAllAttributesAndEvents() establishes a one-shot subscription
    // session with the device. If the device goes offline (Thread border router
    // loses the device, Wi-Fi drop, power cycle, etc.) the session terminates
    // silently — matter.js reconnects the CASE session automatically when the
    // device reappears, but it does NOT re-subscribe.
    //
    // We listen to PairedNode.events.stateChanged. On Disconnected/Reconnecting
    // we mark subscribed=false. On Connected (only after a prior disconnection)
    // we call ensureSubscribed() to re-issue subscribeAllAttributesAndEvents.
    //
    // wasDisconnected guards against re-subscribing on the very first Connected
    // event, which fires during connectNode() before this listener is registered.
    //
    // Remove any previous listener first — activateSubscriptions may be called
    // again on each reconnect cycle.
    const prevStateHandler = this.stateHandlers.get(nodeIdStr);
    if (prevStateHandler) node.events.stateChanged.off(prevStateHandler);

    let wasDisconnected = false;
    const stateHandler = (state: NodeStates) => {
      const entry = this.connectedNodes.get(nodeIdStr);
      if (!entry) {
        // Node was removed — detach this listener
        node.events.stateChanged.off(stateHandler);
        this.stateHandlers.delete(nodeIdStr);
        return;
      }
      if (state === NodeStates.Disconnected || state === NodeStates.Reconnecting) {
        wasDisconnected = true;
        entry.subscribed = false;
        logger.info(`Node ${nodeIdStr} disconnected — subscription lost, will re-subscribe on reconnect`);
      } else if (state === NodeStates.Connected && wasDisconnected) {
        wasDisconnected = false;
        const hasHandlers =
          (this.attrHandlers.get(nodeIdStr)?.size ?? 0) > 0 ||
          (this.eventHandlers.get(nodeIdStr)?.size ?? 0) > 0;
        if (hasHandlers) {
          logger.info(`Node ${nodeIdStr} reconnected — re-subscribing to attributes and events`);
          this.ensureSubscribed(nodeIdStr).catch(e =>
            logger.warn(`Re-subscribe after reconnect failed for ${nodeIdStr}: ${e}`),
          );
        }
      }
    };
    node.events.stateChanged.on(stateHandler);
    this.stateHandlers.set(nodeIdStr, stateHandler);

    logger.info(`Subscribed to all attributes and events for node ${nodeIdStr}`);
  }

  // ----------- Device registry -------------------------------------------

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

    // Clean up any active subscriptions / handlers before removing
    const existingEntry = this.connectedNodes.get(nodeIdStr);
    const existingStateHandler = this.stateHandlers.get(nodeIdStr);
    if (existingEntry && existingStateHandler) {
      existingEntry.node.events.stateChanged.off(existingStateHandler);
    }
    this.stateHandlers.delete(nodeIdStr);
    this.connectedNodes.delete(nodeIdStr);
    this.attrHandlers.delete(nodeIdStr);
    this.eventHandlers.delete(nodeIdStr);

    // tryDecommissioning = !force: properly removes the fabric entry on the
    // device when reachable; falls back to local-only removal on error.
    await ctrl.removeNode(nodeId, !force);

    // Remove from registry and persist
    delete this.registry[nodeIdStr];
    this.saveRegistry();
    logger.info(`Removed device ${nodeIdStr} (force=${force})`);  
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
      if (entry && prevStateHandler) {
        entry.node.events.stateChanged.off(prevStateHandler);
      }
      this.stateHandlers.delete(nodeIdStr);
      this.connectedNodes.delete(nodeIdStr);
      this.subscribingPromises.delete(nodeIdStr);

      const hasHandlers =
        (this.attrHandlers.get(nodeIdStr)?.size ?? 0) > 0 ||
        (this.eventHandlers.get(nodeIdStr)?.size ?? 0) > 0;

      try {
        // withSubscription=true re-subscribes nodes that had active handlers;
        // withSubscription=false just re-establishes the connection.
        await this.getOrConnectNode(nodeIdStr, hasHandlers);
        // Refresh discovery info in registry with fresh cluster/attribute data.
        await this.registerDevice(nodeIdStr);
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
  }

  private loadRegistry(): void {
    try {
      const data = readFileSync(this.registryPath, "utf8");
      this.registry = JSON.parse(data) as DeviceRegistry;
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

  private buildNodeInfo(node: PairedNode): NodeInfo {
    const devices = node.getDevices();
    const endpoints: EndpointInfo[] = devices.map(device => ({
      endpointId: device.number ?? 0,
      clusterIds: [],
    }));
    return { nodeId: node.nodeId.toString(), endpoints };
  }

  private getOrCreateHandlerSet<T>(
    map: Map<string, Set<T>>,
    key: string,
  ): Set<T> {
    if (!map.has(key)) map.set(key, new Set());
    return map.get(key)!;
  }
}
