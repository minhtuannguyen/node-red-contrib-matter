/**
 * ControllerManager — wraps the matter.js CommissioningController in a
 * Node-RED-friendly singleton (one per storage path).
 *
 * Import order matters: @matter/nodejs MUST be imported first so that
 * the Node.js native crypto / network / storage implementations are
 * registered before any Matter object is created.
 */
import "@matter/nodejs";
import type { PairedNode } from "@project-chip/matter.js/device";
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
export declare class ControllerManager {
    private readonly storagePath;
    private readonly port;
    private controller?;
    private started;
    /** If start() is already in progress, all concurrent callers await this same promise. */
    private startingPromise?;
    /** nodeId -> { node, subscribed } */
    private readonly connectedNodes;
    /** nodeId -> attribute handlers */
    private readonly attrHandlers;
    /** nodeId -> event handlers */
    private readonly eventHandlers;
    /**
     * Per-node subscription lock. If subscribeAllAttributesAndEvents() is already
     * in progress for a node, concurrent callers await the same promise instead of
     * each sending their own Subscribe Request to the device.
     */
    private readonly subscribingPromises;
    /**
     * Per-node stateChanged listeners that re-subscribe after the device
     * reconnects following an outage. Kept here so they can be cleanly
     * detached in close() and removeDevice().
     */
    private readonly stateHandlers;
    /** Persisted registry of commissioned devices with their discovery data */
    private registry;
    private registryPath;
    private constructor();
    static getInstance(storagePath: string, port: number): ControllerManager;
    static removeInstance(storagePath: string): void;
    start(): Promise<void>;
    private _doStart;
    close(): Promise<void>;
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
    commission(pairingCode: string, knownAddress?: string, labelOverride?: string): Promise<NodeInfo>;
    /**
     * Returns a list of commissioned node IDs (as decimal strings).
     */
    listCommissionedNodes(): string[];
    /**
     * Returns a connected PairedNode, creating the connection on first call.
     *
     * @param nodeIdStr  Decimal or "0x…" hex string representation of the NodeId.
     * @param withSubscription  When true, ensures the node is subscribed to all
     *                          attributes and events before returning.
     */
    getOrConnectNode(nodeIdStr: string, withSubscription: boolean): Promise<PairedNode>;
    invokeCommand(nodeIdStr: string, endpointId: number, clusterId: number, commandName: string, args: Record<string, unknown>): Promise<unknown>;
    readAttribute(nodeIdStr: string, endpointId: number, clusterId: number, attributeName: string): Promise<unknown>;
    /**
     * Read an attribute value from the local subscription cache without making
     * a network round trip. Useful for emitting initial state right after a
     * subscription is established.
     */
    readCachedAttribute(nodeIdStr: string, endpointId: number, clusterId: number, attributeName: string): Promise<unknown>;
    /**
     * Read Thread diagnostics from ThreadNetworkDiagnostics (cluster 0x0035, endpoint 0).
     * Reads from the local subscription cache (get(false)) — no network round trip.
     * Data is already populated by the active subscription session.
     * Color is based on min neighbor RSSI (best proxy for raw radio signal).
     */
    readSignalStrength(nodeIdStr: string): Promise<SignalInfo>;
    /**
     * Discover all endpoints and clusters of a commissioned node.
     * For each cluster, lists the available attribute names and command names
     * by inspecting the cluster client objects returned by matter.js.
     */
    discoverDevice(nodeIdStr: string): Promise<DeviceDescription>;
    private buildDiscovery;
    /**
     * Register a callback that fires when any attribute on `nodeIdStr` changes.
     * Automatically enables subscription for that node the first time a handler
     * is registered.
     */
    addAttributeHandler(nodeIdStr: string, handler: AttributeChangeHandler): Promise<void>;
    removeAttributeHandler(nodeIdStr: string, handler: AttributeChangeHandler): void;
    /**
     * Register a callback that fires when any event is triggered on `nodeIdStr`.
     * Automatically enables subscription for that node the first time a handler
     * is registered.
     */
    addEventHandler(nodeIdStr: string, handler: EventTriggeredHandler): Promise<void>;
    removeEventHandler(nodeIdStr: string, handler: EventTriggeredHandler): void;
    private requireController;
    private ensureSubscribed;
    private activateSubscriptions;
    /**
     * Returns the persisted registry of commissioned devices with their discovery data.
     * Used by the Node-RED admin UI to populate cascading dropdowns.
     */
    getRegistry(): DeviceRegistry;
    /**
     * Decommissions a node from the Matter fabric and removes it from the local
     * registry.
     *
     * @param nodeIdStr  Decimal node ID string
     * @param force      When true, skips fabric-level decommissioning and only
     *                   erases local storage (use when the device is unreachable).
     *                   Default: false (attempts proper decommissioning first).
     */
    removeDevice(nodeIdStr: string, force?: boolean): Promise<void>;
    /**
     * Rename a device in the registry without reconnecting.
     */
    renameDevice(nodeIdStr: string, newLabel: string): void;
    /**
     * Re-discover all registered devices — forces matter.js to reconnect via
     * mDNS and refresh its internal peer address cache. Useful after a Thread
     * Border Router (e.g. HomePod) moves and all device IPv6 addresses change.
     *
     * Nodes that have active attribute/event subscriptions are automatically
     * re-subscribed after reconnection.
     */
    rediscoverAll(): Promise<void>;
    /**
     * Discovers a commissioned device and persists the result in the registry.
     * Called automatically after commissioning; can also be triggered manually.
     *
     * @param labelOverride  When provided, uses this as the registry label instead of
     *                       the productName read from the device.
     */
    registerDevice(nodeIdStr: string, labelOverride?: string): Promise<void>;
    private loadRegistry;
    private saveRegistry;
    private buildNodeInfo;
    private getOrCreateHandlerSet;
}
//# sourceMappingURL=controller-manager.d.ts.map