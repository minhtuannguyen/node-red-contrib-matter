/**
 * ControllerManager — wraps the matter.js CommissioningController in a
 * Node-RED-friendly singleton (one per storage path).
 *
 * Import order matters: @matter/nodejs MUST be imported first so that
 * the Node.js native crypto / network / storage implementations are
 * registered before any Matter object is created.
 */
import "@matter/nodejs";

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { CommissioningController } from "@project-chip/matter.js";
import type {
  CommissioningControllerNodeOptions,
  PairedNode,
} from "@project-chip/matter.js/device";
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
}

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
  timestamp: Date;
}

export interface EventTriggeredEvent {
  nodeId: string;
  endpointId: number;
  clusterId: number;
  eventName: string;
  events: unknown[];
  timestamp: Date;
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
  async commission(pairingCode: string, knownAddress?: string): Promise<NodeInfo> {
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
    logger.info(`Commissioned node: ${nodeId}`);

    return this.buildNodeInfo(await this.getOrConnectNode(nodeId.toString(), false));
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
   * Discover all endpoints and clusters of a commissioned node.
   * For each cluster, lists the available attribute names and command names
   * by inspecting the cluster client objects returned by matter.js.
   */
  async discoverDevice(nodeIdStr: string): Promise<DeviceDescription> {
    const node = await this.getOrConnectNode(nodeIdStr, false);
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

        clusters.push({
          clusterId,
          clusterIdHex: clusterId.toString(16).toUpperCase().padStart(4, "0"),
          clusterName:  CLUSTER_NAMES[clusterId] ?? `Unknown (0x${clusterId.toString(16).padStart(4, "0")})`,
          attributes,
          commands,
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
    this.attrHandlers.get(nodeIdStr)?.delete(handler);
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
    this.eventHandlers.get(nodeIdStr)?.delete(handler);
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
    if (existing) {
      if (!existing.subscribed) {
        await this.activateSubscriptions(nodeIdStr, existing.node);
        existing.subscribed = true;
      }
    } else {
      // Not yet connected — connect WITH subscriptions
      await this.getOrConnectNode(nodeIdStr, true);
    }
  }

  private async activateSubscriptions(nodeIdStr: string, node: PairedNode): Promise<void> {
    this.attachObservables(nodeIdStr, node);
    // Explicitly subscribe — required for sleepy/ICD devices (e.g. Thread locks).
    // autoSubscribe:false + explicit call works for both always-on and sleepy devices.
    // ignoreInitialTriggers:false ensures we get the current state on subscribe.
    await node.subscribeAllAttributesAndEvents({ ignoreInitialTriggers: false });
    logger.info(`Subscribed to all attributes and events for node ${nodeIdStr}`);
  }

  private attachObservables(nodeIdStr: string, node: PairedNode): void {
    const attrObs = (data: { path: { nodeId?: bigint; endpointId: number; clusterId: number; attributeName: string }; value: unknown }) => {
      const handlers = this.attrHandlers.get(nodeIdStr);
      if (!handlers?.size) return;
      const event: AttributeChangedEvent = {
        nodeId: nodeIdStr,
        endpointId: data.path.endpointId,
        clusterId: data.path.clusterId,
        attributeName: data.path.attributeName,
        value: data.value,
        timestamp: new Date(),
      };
      for (const h of handlers) {
        try { h(event); } catch { /* keep other handlers running */ }
      }
    };

    const evtObs = (data: { path: { nodeId?: bigint; endpointId: number; clusterId: number; eventName: string }; events: unknown[] }) => {
      const handlers = this.eventHandlers.get(nodeIdStr);
      if (!handlers?.size) return;
      const event: EventTriggeredEvent = {
        nodeId: nodeIdStr,
        endpointId: data.path.endpointId,
        clusterId: data.path.clusterId,
        eventName: data.path.eventName,
        events: data.events,
        timestamp: new Date(),
      };
      for (const h of handlers) {
        try { h(event); } catch { /* keep other handlers running */ }
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node.events.attributeChanged as any).on(attrObs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node.events.eventTriggered as any).on(evtObs);
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
