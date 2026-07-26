/**
 * ControllerManager — wraps the matter.js CommissioningController in a
 * Node-RED-friendly singleton (one per storage path).
 *
 * @matter/nodejs is loaded lazily inside _doStart() so that Boot.init fires
 * after environment configuration is applied.
 */
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
export declare class ControllerManager {
    private readonly storagePath;
    private readonly port;
    private readonly logLevel;
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
    /** nodeId -> (handler -> filter) — used for callback-level dispatch filtering */
    private readonly attrHandlerFilters;
    private readonly eventHandlerFilters;
    /**
     * Per-node connection lock. If a connectNode() call is already in progress for
     * a node, concurrent callers share the same promise instead of each starting
     * an independent CASE session attempt (which could each take up to 30 s when
     * the device is offline, wasting memory and network retries).
     */
    private readonly connectingPromises;
    /**
     * Per-node subscription lock. If a subscription is already in progress for a
     * node, concurrent callers await the same promise instead of each sending
     * their own Subscribe Request to the device.
     */
    private readonly subscribingPromises;
    /**
     * Per-node stateChanged listeners that re-subscribe after the device
     * reconnects following an outage. Kept here so they can be cleanly
     * detached in close() and removeDevice().
     */
    private readonly stateHandlers;
    /**
     * Maps nodeId → PairedNode for nodes whose stateHandler is active but whose
     * connectedNodes entry has been evicted (i.e. the node is in Disconnected or
     * Reconnecting state).  Required so close() can call .off(handler) on the
     * correct node even when the node is absent from connectedNodes.
     */
    private readonly stateHandlerNodes;
    /**
     * Tracks the last time we received a subscription report (attribute or event)
     * for each node. Used by the health check to detect stale subscriptions on
     * devices with poor/intermittent connectivity (e.g. Thread sensors with RSSI < -90 dBm).
     */
    private readonly lastReportTime;
    /**
     * Periodic health check timer that detects stale subscriptions and triggers
     * reconnection. Runs every 60 seconds to catch devices that silently stop
     * sending reports without triggering Matter.js state changes.
     */
    private healthCheckInterval?;
    /**
     * Consecutive failed (re)connect attempts per node, used to back off retry
     * frequency for chronically-unstable devices (e.g. a battery Nuki lock with
     * a flaky BLE/Thread hop). Without this, a permanently-troubled device gets
     * a fresh CASE-handshake attempt every single 60s health-check tick forever
     * — each attempt allocates exchange/crypto objects that are individually
     * disposed on failure but, under constant churn, keep the V8 heap "warm"
     * and prevent it from settling back down between GC cycles, which shows up
     * as a slow upward drift in heap graphs even though nothing is technically
     * un-freeable. Backing off the retry interval for a repeatedly-failing node
     * reduces that churn while still recovering quickly for a healthy device.
     */
    private readonly reconnectFailureCount;
    /** Earliest wall-clock time (ms) the next reconnect attempt is allowed for a node. */
    private readonly nextReconnectAllowedAt;
    /** Base health-check cadence — kept in sync with startHealthCheck()'s interval. */
    private static readonly HEALTH_CHECK_INTERVAL_MS;
    /** Upper bound on backoff so a device that comes back online is retried at least this often. */
    private static readonly MAX_RECONNECT_BACKOFF_MS;
    /**
     * Returns true if a reconnect attempt for `nodeIdStr` should be skipped because
     * we are still within its backoff window from previous consecutive failures.
     */
    private isReconnectBackedOff;
    /** Clears backoff state after a successful (re)connect + subscribe. */
    private resetReconnectBackoff;
    /**
     * Records a failed (re)connect attempt and schedules the next allowed retry
     * using exponential backoff off the base health-check cadence, capped at
     * MAX_RECONNECT_BACKOFF_MS: 60s, 120s, 240s, 480s, 900s (cap), ...
     */
    private scheduleReconnectBackoff;
    /**
     * Attempts a reconnect+subscribe for `nodeIdStr`, resetting backoff on success
     * and scheduling the next backed-off attempt on failure. Used by performHealthCheck()
     * so repeated failures for a chronically-unstable device space themselves out
     * instead of retrying every single health-check tick forever.
     */
    private attemptBackedOffReconnect;
    /** Persisted registry of commissioned devices with their discovery data */
    private registry;
    private registryPath;
    private constructor();
    static getInstance(storagePath: string, port: number, logLevel?: string): ControllerManager;
    static removeInstance(storagePath: string): void;
    private applyLogLevel;
    /**
     * Returns true if any attribute or event handler is registered for the node.
     * Used to decide between a persistent cached connection (subscribed device)
     * and a transient connect-use-disconnect pattern (command/read-only device).
     */
    private hasActiveHandlers;
    /**
     * If the node has no active handlers it was connected transiently just for
     * this operation. Disconnect it now to free the CASE session and cluster
     * client objects (~15 MB per device).
     */
    private releaseIfTransient;
    /**
     * Called after handler removal to disconnect nodes that no longer have any
     * active handlers. Asynchronously cleans up the connection in the background
     * without blocking the removal operation.
     */
    private releaseIfNoHandlers;
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
     *
     * Supply `filter` with at least a `clusterId` to opt into selective
     * subscription (only that cluster is subscribed, saving memory).
     * If any handler has no clusterId filter the node falls back to a full
     * `subscribeAllAttributesAndEvents` for that device.
     */
    addAttributeHandler(nodeIdStr: string, handler: AttributeChangeHandler, filter?: SubscriptionFilter): Promise<void>;
    removeAttributeHandler(nodeIdStr: string, handler: AttributeChangeHandler): void;
    /**
     * Register a callback that fires when any event is triggered on `nodeIdStr`.
     * Automatically enables subscription for that node the first time a handler
     * is registered.
     *
     * Supply `filter` with at least a `clusterId` to opt into selective
     * subscription.
     */
    addEventHandler(nodeIdStr: string, handler: EventTriggeredHandler, filter?: SubscriptionFilter): Promise<void>;
    removeEventHandler(nodeIdStr: string, handler: EventTriggeredHandler): void;
    private requireController;
    /**
     * Computes a signature describing which clusters the CURRENT set of
     * registered handlers for nodeIdStr needs covered: "full" when at least
     * one handler has no clusterId filter, otherwise a sorted, de-duplicated
     * list of attribute/event cluster IDs. Used by ensureSubscribed() to
     * detect when a newly-registered handler's filter is not yet covered by
     * the live subscription (see subscribedFilterSignature below).
     */
    private computeFilterSignature;
    /**
     * Records which filter signature (see computeFilterSignature) is actually
     * covered by the most recently completed subscription, per node. Two (or
     * more) matter-subscribe nodes registered against the same device can race
     * at startup: if node B's handler is added after node A's subscribe has
     * already read the filter set and completed, `existing.subscribed` alone
     * would look "done" and node B's cluster would silently never be
     * subscribed until the next reconnect (health check / heartbeat timeout).
     * Comparing signatures here forces a re-subscribe whenever the desired
     * coverage changes — safe because activateSubscriptions() always uses
     * `keepSubscriptions: false`, so the previous subscription is cleanly
     * replaced rather than stacked.
     */
    private readonly subscribedFilterSignature;
    private ensureSubscribed;
    private activateSubscriptions;
    /**
     * Returns true when every registered handler for `nodeIdStr` supplies a
     * clusterId filter, meaning we can use a selective Matter Subscribe Request
     * (one message, specific cluster paths) instead of subscribing to the whole
     * device. This cuts per-device cached data from ~15 MB to ~1-2 MB.
     */
    private canUseSelectiveSubscription;
    /**
     * Selective subscription using InteractionClient.subscribeMultipleAttributesAndEvents().
     * Sends a single Matter Subscribe Request listing only the specific cluster IDs
     * that have registered handlers. The device pushes only those clusters, so
     * matter.js only caches that data — dramatically less memory than full subscription.
     *
     * Falls back to full subscription if getInteractionClient() fails.
     */
    private activateSelectiveSubscription;
    /**
     * Subscribes to all attributes and events on the device.
     *
     * NOTE: In matter.js 0.17, `subscribeAllAttributesAndEvents()` ignores passed
     * callbacks and does nothing when `autoSubscribe=false` (the underscore prefix
     * on `_options` marks the parameter as intentionally unused). We therefore use
     * `subscribeMultipleAttributesAndEvents` with wildcard paths (empty objects =
     * all endpoints/clusters) so the same proven code path handles both modes.
     */
    private activateFullSubscription;
    /**
     * Returns a callback for matter.js `updateTimeoutHandler`. matter.js invokes
     * this via the subscription's generic `closed` hook — which fires on EVERY
     * close, not only a real heartbeat timeout:
     *
     *   1. Genuine timeout   — device stopped sending reports (what we want to act on).
     *   2. Self-inflicted    — our own `keepSubscriptions: false` re-subscribe closes
     *                          the previous PeerSubscription for this peer before
     *                          installing the new one (ClientInteraction.subscribe).
     *   3. Shutdown          — controller.close() tears every subscription down.
     *
     * Only case (1) should trigger a reconnect. Cases (2) and (3) are self-inflicted:
     * a subscribe/connect is already in flight (subscribingPromises / connectingPromises
     * is populated the moment the replacement close fires, because that close happens
     * synchronously INSIDE our own subscribeMultipleAttributesAndEvents call), or the
     * controller is stopping. Acting on those would tear down the fresh connection we
     * just created and immediately re-subscribe — which closes the next subscription,
     * firing this handler again, spiralling into a self-perpetuating reconnect loop
     * that allocates a new CASE session + PeerSubscription + listener closures on every
     * turn. On an unstable connection (frequent reconnects) that churn is a steady heap
     * leak. The guard below distinguishes a real timeout (nothing in flight, controller
     * running) from a self-inflicted replacement/shutdown close.
     */
    private makeUpdateTimeoutHandler;
    /**
     * Starts the periodic health check that detects stale subscriptions.
     * Runs every 60 seconds to catch devices with poor connectivity (Thread sensors
     * with RSSI < -90 dBm) that silently stop sending reports without triggering
     * Matter.js state changes. More aggressive than updateTimeoutHandler for faster
     * recovery on intermittent connections.
     */
    private startHealthCheck;
    /**
     * Health check logic: for each subscribed node, verify we've received a report
     * within the expected maxInterval window + grace period. If not, proactively
     * reconnect even if Matter.js still thinks the node is "Connected".
     *
     * Iterates over all nodes with active handlers (not just connectedNodes) to
     * ensure nodes that failed reconnection are retried on every health check cycle.
     */
    private performHealthCheck;
    /**
     * Builds the attribute-change dispatcher closure for `nodeIdStr`.
     * Extracted so both selective and full subscription paths share identical logic.
     * The returned function is stored by the matter.js subscription and lives for
     * the connection lifetime — no per-event allocation beyond the event object itself.
     */
    private makeAttrListener;
    /**
     * Builds the event-triggered dispatcher closure for `nodeIdStr`.
     * Extracted so both selective and full subscription paths share identical logic.
     */
    private makeEvtListener;
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
    private setupStateHandler;
    /**
     * Deletes storage cache files that belong to nodeIds which are no longer in
     * the registry (decommissioned devices). Called once at startup before
     * matter.js loads the cache into memory, so stale data never occupies heap.
     *
     * Safe: only removes files matching `nodes.{nodeId}.*` where nodeId is not
     * in the active registry. Commissioning data (fabrics.*, sessions.*, etc.)
     * is left untouched.
     */
    private cleanStaleNodeCache;
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
    private getOrCreateHandlerSet;
}
//# sourceMappingURL=controller-manager.d.ts.map