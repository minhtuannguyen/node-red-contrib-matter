/**
 * Unit tests for ControllerManager.
 *
 * All matter.js/Node.js networking dependencies are mocked so these tests
 * run without a real Matter network or hardware.
 */

// ---------------------------------------------------------------------------
// Module-level mocks — Jest hoists these above imports automatically
// ---------------------------------------------------------------------------

// Side-effect import — mock so it doesn't register native Node.js platforms
jest.mock("@matter/nodejs", () => ({}));

jest.mock("@matter/general", () => ({
  Logger: {
    get: (_name: string) => ({
      info:  jest.fn(),
      warn:  jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
    defaultLogLevel: 1,
  },
  LogLevel: {
    DEBUG:  0,
    INFO:   1,
    NOTICE: 2,
    WARN:   3,
    ERROR:  4,
    FATAL:  5,
  },
  // Used via dynamic require() inside _doStart()
  Environment: {
    default: { vars: { set: jest.fn() } },
  },
}));

jest.mock("@matter/types", () => ({
  ClusterId:                (v: number) => v,
  EndpointNumber:           (v: number) => v,
  ManualPairingCodeCodec:   {
    decode: jest.fn().mockReturnValue({ shortDiscriminator: 1, passcode: 12345 }),
  },
  NodeId: (v: bigint) => v,
}));

// ---------------------------------------------------------------------------
// PairedNode mock factory
// ---------------------------------------------------------------------------

interface MockStateChangedObservable {
  on:    jest.Mock;
  off:   jest.Mock;
  /** Synchronously invoke all currently-registered listeners. */
  _emit: (state: number) => void;
}

interface MockPairedNode {
  initialized: boolean;
  events: {
    initialized: unknown;
    stateChanged: MockStateChangedObservable;
  };
  nodeId: bigint;
  subscribeAllAttributesAndEvents: jest.Mock;
  getRootEndpoint: jest.Mock;
  getDevices: jest.Mock;
  getDeviceById: jest.Mock;
}

function makePairedNode(overrides: Partial<MockPairedNode> = {}): MockPairedNode {
  const listeners = new Set<(state: number) => void>();
  const stateChanged: MockStateChangedObservable = {
    on:    jest.fn((h: (s: number) => void) => listeners.add(h)),
    off:   jest.fn((h: (s: number) => void) => listeners.delete(h)),
    _emit: (state: number) => { for (const h of listeners) h(state); },
  };
  return {
    initialized: true,
    events: { initialized: Promise.resolve(), stateChanged },
    nodeId: BigInt(12345),
    subscribeAllAttributesAndEvents: jest.fn().mockResolvedValue(undefined),
    getRootEndpoint: jest.fn().mockReturnValue({
      getClusterClientById: jest.fn().mockReturnValue(null),
    }),
    getDevices:    jest.fn().mockReturnValue([]),
    getDeviceById: jest.fn().mockReturnValue(null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CommissioningController mock
// ---------------------------------------------------------------------------

const mockControllerStart  = jest.fn().mockResolvedValue(undefined);
const mockControllerClose  = jest.fn().mockResolvedValue(undefined);
const mockCommissionNode   = jest.fn().mockResolvedValue(BigInt(12345));
const mockRemoveNode       = jest.fn().mockResolvedValue(undefined);
let   mockConnectNode      = jest.fn().mockResolvedValue(makePairedNode());

jest.mock("@project-chip/matter.js", () => ({
  CommissioningController: jest.fn().mockImplementation(() => ({
    start:                mockControllerStart,
    close:                mockControllerClose,
    commissionNode:       mockCommissionNode,
    removeNode:           mockRemoveNode,
    getCommissionedNodes: jest.fn().mockReturnValue([]),
    connectNode:          (...args: unknown[]) => mockConnectNode(...args),
  })),
}));

jest.mock("@project-chip/matter.js/device", () => ({
  // Must match NodeStates enum values from the real module
  NodeStates: { Connected: 0, Disconnected: 1, Reconnecting: 2 },
}));

// ---------------------------------------------------------------------------
// Filesystem mocks
// ---------------------------------------------------------------------------

const mockMkdirSync  = jest.fn();
const mockReadFileSync = jest.fn().mockImplementation(() => {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  throw err;
});
const mockWriteFile = jest.fn().mockResolvedValue(undefined);

jest.mock("node:fs", () => ({
  mkdirSync:    (...args: unknown[]) => mockMkdirSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

jest.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { ControllerManager } from "../../src/lib/controller-manager";

const STORAGE_A = "/tmp/test-matter-A";
const STORAGE_B = "/tmp/test-matter-B";

afterEach(() => {
  // Clean up singleton instances so each test starts fresh
  ControllerManager.removeInstance(STORAGE_A);
  ControllerManager.removeInstance(STORAGE_B);
  // Reset per-call mocks
  mockConnectNode = jest.fn().mockResolvedValue(makePairedNode());
  mockWriteFile.mockClear();
  mockCommissionNode.mockClear();
  mockRemoveNode.mockClear();
  mockControllerStart.mockClear();
  mockControllerClose.mockClear();
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe("ControllerManager.getInstance()", () => {
  it("returns the same instance for the same storage path", () => {
    const a = ControllerManager.getInstance(STORAGE_A, 5540);
    const b = ControllerManager.getInstance(STORAGE_A, 5540);
    expect(a).toBe(b);
  });

  it("returns different instances for different storage paths", () => {
    const a = ControllerManager.getInstance(STORAGE_A, 5540);
    const b = ControllerManager.getInstance(STORAGE_B, 5540);
    expect(a).not.toBe(b);
  });

  it("creates a fresh instance after removeInstance()", () => {
    const a = ControllerManager.getInstance(STORAGE_A, 5540);
    ControllerManager.removeInstance(STORAGE_A);
    const b = ControllerManager.getInstance(STORAGE_A, 5540);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe("start()", () => {
  it("calls CommissioningController.start() once", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    expect(mockControllerStart).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second call does not re-start", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    await m.start();
    expect(mockControllerStart).toHaveBeenCalledTimes(1);
  });

  it("concurrent calls share a single _doStart() execution", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    // Both calls are issued before either resolves
    await Promise.all([m.start(), m.start(), m.start()]);
    expect(mockControllerStart).toHaveBeenCalledTimes(1);
  });

  it("creates storage directory via mkdirSync", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("node-red-matter"),
      { recursive: true },
    );
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("close()", () => {
  it("calls CommissioningController.close() and removes instance", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    await m.close();
    expect(mockControllerClose).toHaveBeenCalledTimes(1);
    // After close, getInstance creates a new object
    const m2 = ControllerManager.getInstance(STORAGE_A, 5540);
    expect(m2).not.toBe(m);
    ControllerManager.removeInstance(STORAGE_A); // clean up m2
  });

  it("is a no-op if never started", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await expect(m.close()).resolves.toBeUndefined();
    expect(mockControllerClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("getRegistry()", () => {
  it("returns an empty object when registry file does not exist", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    expect(m.getRegistry()).toEqual({});
  });

  it("loads persisted registry from disk on start()", async () => {
    const stored = {
      "12345": {
        label: "Light",
        nodeId: "12345",
        discoveredAt: "2025-01-01T00:00:00.000Z",
        discovery: { nodeId: "12345", endpoints: [] },
      },
    };
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(stored));
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    expect(m.getRegistry()).toEqual(stored);
  });
});

// ---------------------------------------------------------------------------
// commission()
// ---------------------------------------------------------------------------

describe("commission()", () => {
  it("returns NodeInfo immediately without blocking", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    // Make connectNode take a long time (simulates slow device reconnect)
    mockConnectNode = jest.fn().mockReturnValue(new Promise(() => { /* never resolves */ }));

    const result = await Promise.race([
      m.commission("12345678901"),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);

    expect(result).not.toBeNull();
    expect((result as { nodeId: string }).nodeId).toBe("12345");
  });

  it("returns nodeId as decimal string", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    mockConnectNode = jest.fn().mockReturnValue(new Promise(() => {})); // never resolves background task
    const info = await m.commission("12345678901");
    expect(info.nodeId).toBe("12345");
    expect(info.endpoints).toEqual([]);
  });

  it("passes stripped pairing code to commissionNode", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    mockConnectNode = jest.fn().mockResolvedValue(makePairedNode());
    // This test verifies ManualPairingCodeCodec.decode is called
    await m.commission("12345678901");
    const { ManualPairingCodeCodec } = jest.requireMock("@matter/types") as {
      ManualPairingCodeCodec: { decode: jest.Mock };
    };
    expect(ManualPairingCodeCodec.decode).toHaveBeenCalledWith("12345678901");
  });
});

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

describe("addAttributeHandler() / removeAttributeHandler()", () => {
  it("registered handler is invoked by subscription callback", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const pairedNode = makePairedNode();
    let capturedAttrCb: ((data: unknown) => void) | undefined;
    pairedNode.subscribeAllAttributesAndEvents = jest.fn().mockImplementation(
      (opts: { attributeChangedCallback: (d: unknown) => void }) => {
        capturedAttrCb = opts.attributeChangedCallback;
        return Promise.resolve();
      },
    );
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    const handler = jest.fn();
    await m.addAttributeHandler("12345", handler);

    // Simulate attribute change arriving from the device
    capturedAttrCb!({
      path: { endpointId: 1, clusterId: 6, attributeName: "onOff" },
      value: true,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as Record<string, unknown>;
    expect(event.nodeId).toBe("12345");
    expect(event.endpointId).toBe(1);
    expect(event.clusterId).toBe(6);
    expect(event.attributeName).toBe("onOff");
    expect(event.value).toBe(true);
    expect(typeof event.timestamp).toBe("string");
  });

  it("removed handler is no longer invoked", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const pairedNode = makePairedNode();
    let capturedAttrCb: ((data: unknown) => void) | undefined;
    pairedNode.subscribeAllAttributesAndEvents = jest.fn().mockImplementation(
      (opts: { attributeChangedCallback: (d: unknown) => void }) => {
        capturedAttrCb = opts.attributeChangedCallback;
        return Promise.resolve();
      },
    );
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    const handler = jest.fn();
    await m.addAttributeHandler("12345", handler);
    m.removeAttributeHandler("12345", handler);

    capturedAttrCb!({
      path: { endpointId: 1, clusterId: 6, attributeName: "onOff" },
      value: false,
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("addEventHandler() / removeEventHandler()", () => {
  it("registered event handler is invoked by subscription callback", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const pairedNode = makePairedNode();
    let capturedEvtCb: ((data: unknown) => void) | undefined;
    pairedNode.subscribeAllAttributesAndEvents = jest.fn().mockImplementation(
      (opts: { eventTriggeredCallback: (d: unknown) => void }) => {
        capturedEvtCb = opts.eventTriggeredCallback;
        return Promise.resolve();
      },
    );
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    const handler = jest.fn();
    await m.addEventHandler("12345", handler);

    capturedEvtCb!({
      path: { endpointId: 1, clusterId: 0x0101, eventName: "DoorLockAlarm" },
      events: [{ alarmCode: 0 }],
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as Record<string, unknown>;
    expect(event.eventName).toBe("DoorLockAlarm");
    expect(Array.isArray(event.events)).toBe(true);
    expect(typeof event.timestamp).toBe("string");
  });

  it("removed event handler is no longer invoked", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const pairedNode = makePairedNode();
    let capturedEvtCb: ((data: unknown) => void) | undefined;
    pairedNode.subscribeAllAttributesAndEvents = jest.fn().mockImplementation(
      (opts: { eventTriggeredCallback: (d: unknown) => void }) => {
        capturedEvtCb = opts.eventTriggeredCallback;
        return Promise.resolve();
      },
    );
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    const handler = jest.fn();
    await m.addEventHandler("12345", handler);
    m.removeEventHandler("12345", handler);

    capturedEvtCb!({
      path: { endpointId: 1, clusterId: 0x0101, eventName: "DoorLockAlarm" },
      events: [],
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Subscription lock (concurrent subscribe race condition)
// ---------------------------------------------------------------------------

describe("ensureSubscribed() subscription lock", () => {
  it("calls subscribeAllAttributesAndEvents exactly once for concurrent handlers on the same node", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const pairedNode = makePairedNode();
    // subscribeAllAttributesAndEvents deferred — simulates slow device
    let resolveSubscribe!: () => void;
    pairedNode.subscribeAllAttributesAndEvents = jest.fn().mockReturnValue(
      new Promise<void>((resolve) => { resolveSubscribe = resolve; }),
    );
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    const h1 = jest.fn();
    const h2 = jest.fn();
    // Both calls issued concurrently before either promise resolves
    const p1 = m.addAttributeHandler("12345", h1);
    const p2 = m.addAttributeHandler("12345", h2);

    resolveSubscribe();
    await Promise.all([p1, p2]);

    expect(pairedNode.subscribeAllAttributesAndEvents).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// timestamp is an ISO-8601 string (not a Date object)
// ---------------------------------------------------------------------------

describe("event timestamps", () => {
  it("attribute event timestamp is an ISO-8601 string", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const pairedNode = makePairedNode();
    let cb!: (d: unknown) => void;
    pairedNode.subscribeAllAttributesAndEvents = jest.fn().mockImplementation(
      (opts: { attributeChangedCallback: (d: unknown) => void }) => {
        cb = opts.attributeChangedCallback;
        return Promise.resolve();
      },
    );
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    const handler = jest.fn();
    await m.addAttributeHandler("12345", handler);
    cb({ path: { endpointId: 1, clusterId: 6, attributeName: "onOff" }, value: true });

    const event = handler.mock.calls[0][0] as { timestamp: unknown };
    expect(typeof event.timestamp).toBe("string");
    expect(() => new Date(event.timestamp as string).toISOString()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// saveRegistry() uses async writeFile with compact JSON
// ---------------------------------------------------------------------------

describe("saveRegistry() via removeDevice()", () => {
  it("calls writeFile with compact JSON (no indentation)", async () => {
    const stored = {
      "12345": {
        label: "Lock",
        nodeId: "12345",
        discoveredAt: "2025-01-01T00:00:00.000Z",
        discovery: { nodeId: "12345", endpoints: [] },
      },
    };
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(stored));

    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    await m.removeDevice("12345", true);

    expect(mockWriteFile).toHaveBeenCalled();
    const [, content] = mockWriteFile.mock.calls[0] as [string, string];
    // Compact JSON has no newlines
    expect(content).not.toContain("\n");
    expect(JSON.parse(content)).not.toHaveProperty("12345");
  });
});

// ---------------------------------------------------------------------------
// listCommissionedNodes()
// ---------------------------------------------------------------------------

describe("listCommissionedNodes()", () => {
  it("returns decimal strings for each commissioned node", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();
    const { CommissioningController } = jest.requireMock("@project-chip/matter.js") as {
      CommissioningController: jest.Mock;
    };
    const ctrlInstance = CommissioningController.mock.results[
      CommissioningController.mock.results.length - 1
    ].value as { getCommissionedNodes: jest.Mock };
    ctrlInstance.getCommissionedNodes.mockReturnValue([BigInt(1), BigInt(2)]);

    const nodes = m.listCommissionedNodes();
    expect(nodes).toEqual(["1", "2"]);
  });
});

// ---------------------------------------------------------------------------
// Re-subscription after device reconnect (bug fix)
// ---------------------------------------------------------------------------

// NodeStates values as mocked by jest.mock("@project-chip/matter.js/device")
const NS = { Connected: 0, Disconnected: 1, Reconnecting: 2 };

describe("Re-subscription after device reconnect", () => {
  function makeReconnectableNode() {
    const pairedNode = makePairedNode();
    let capturedAttrCb: ((data: unknown) => void) | undefined;
    pairedNode.subscribeAllAttributesAndEvents = jest.fn().mockImplementation(
      (opts: { attributeChangedCallback: (d: unknown) => void }) => {
        capturedAttrCb = opts.attributeChangedCallback;
        return Promise.resolve();
      },
    );
    return { pairedNode, getAttrCb: () => capturedAttrCb };
  }

  it("re-calls subscribeAllAttributesAndEvents after Disconnected → Connected", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const { pairedNode } = makeReconnectableNode();
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    await m.addAttributeHandler("12345", jest.fn());
    expect(pairedNode.subscribeAllAttributesAndEvents).toHaveBeenCalledTimes(1);

    // Device goes offline
    pairedNode.events.stateChanged._emit(NS.Disconnected);
    // Device comes back
    pairedNode.events.stateChanged._emit(NS.Connected);
    await new Promise((r) => setImmediate(r));

    expect(pairedNode.subscribeAllAttributesAndEvents).toHaveBeenCalledTimes(2);
  });

  it("attribute events flow again after re-subscription", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const { pairedNode, getAttrCb } = makeReconnectableNode();
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    const handler = jest.fn();
    await m.addAttributeHandler("12345", handler);

    // Fire event before disconnect — should be received
    getAttrCb()!({ path: { endpointId: 1, clusterId: 6, attributeName: "onOff" }, value: true });
    expect(handler).toHaveBeenCalledTimes(1);

    // Simulate outage and reconnect
    pairedNode.events.stateChanged._emit(NS.Disconnected);
    pairedNode.events.stateChanged._emit(NS.Connected);
    await new Promise((r) => setImmediate(r));

    // Fire event after reconnect — new callback captured by second subscribe call
    getAttrCb()!({ path: { endpointId: 1, clusterId: 6, attributeName: "onOff" }, value: false });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not re-subscribe if no handlers remain after disconnect", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const { pairedNode } = makeReconnectableNode();
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    const handler = jest.fn();
    await m.addAttributeHandler("12345", handler);
    // Remove the only handler
    m.removeAttributeHandler("12345", handler);

    pairedNode.events.stateChanged._emit(NS.Disconnected);
    pairedNode.events.stateChanged._emit(NS.Connected);
    await new Promise((r) => setImmediate(r));

    // Still only 1 subscription (the initial one)
    expect(pairedNode.subscribeAllAttributesAndEvents).toHaveBeenCalledTimes(1);
  });

  it("Connected without prior Disconnected does not trigger re-subscription", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const { pairedNode } = makeReconnectableNode();
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    await m.addAttributeHandler("12345", jest.fn());
    expect(pairedNode.subscribeAllAttributesAndEvents).toHaveBeenCalledTimes(1);

    // Fire Connected without a prior Disconnected — wasDisconnected=false guard
    pairedNode.events.stateChanged._emit(NS.Connected);
    await new Promise((r) => setImmediate(r));

    // Must still be exactly 1
    expect(pairedNode.subscribeAllAttributesAndEvents).toHaveBeenCalledTimes(1);
  });

  it("registers only one stateChanged listener per node even after multiple reconnects", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const { pairedNode } = makeReconnectableNode();
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    await m.addAttributeHandler("12345", jest.fn());
    const { on, off } = pairedNode.events.stateChanged;

    // First subscription: one .on() call
    expect((on as jest.Mock).mock.calls.length).toBe(1);

    // First reconnect
    pairedNode.events.stateChanged._emit(NS.Disconnected);
    pairedNode.events.stateChanged._emit(NS.Connected);
    await new Promise((r) => setImmediate(r));

    // The old listener was removed (.off called once) and a new one added
    expect((off as jest.Mock).mock.calls.length).toBe(1);
    expect((on as jest.Mock).mock.calls.length).toBe(2);

    // Second reconnect
    pairedNode.events.stateChanged._emit(NS.Disconnected);
    pairedNode.events.stateChanged._emit(NS.Connected);
    await new Promise((r) => setImmediate(r));

    expect((off as jest.Mock).mock.calls.length).toBe(2);
    expect((on as jest.Mock).mock.calls.length).toBe(3);
  });

  it("Reconnecting state also marks subscribed=false", async () => {
    const m = ControllerManager.getInstance(STORAGE_A, 5540);
    await m.start();

    const { pairedNode } = makeReconnectableNode();
    mockConnectNode = jest.fn().mockResolvedValue(pairedNode);

    await m.addAttributeHandler("12345", jest.fn());

    // Reconnecting (not full disconnect) should still trigger re-subscribe on reconnect
    pairedNode.events.stateChanged._emit(NS.Reconnecting);
    pairedNode.events.stateChanged._emit(NS.Connected);
    await new Promise((r) => setImmediate(r));

    expect(pairedNode.subscribeAllAttributesAndEvents).toHaveBeenCalledTimes(2);
  });
});

