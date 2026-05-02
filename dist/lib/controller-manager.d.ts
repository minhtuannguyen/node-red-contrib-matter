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
     * Discover all endpoints and clusters of a commissioned node.
     * For each cluster, lists the available attribute names and command names
     * by inspecting the cluster client objects returned by matter.js.
     */
    discoverDevice(nodeIdStr: string): Promise<DeviceDescription>;
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
     * Discovers a commissioned device and persists the result in the registry.
     * Called automatically after commissioning; can also be triggered manually.
     *
     * @param labelOverride  When provided, uses this as the registry label instead of
     *                       the productName read from the device.
     */
    registerDevice(nodeIdStr: string, labelOverride?: string): Promise<void>;
    private loadRegistry;
    private saveRegistrySync;
    private buildNodeInfo;
    private getOrCreateHandlerSet;
}
//# sourceMappingURL=controller-manager.d.ts.map