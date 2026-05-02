/**
 * Tests for the matter-subscribe node.
 *
 * Verifies filter logic and message routing without a real Matter device.
 */

import path from "path";
import {
  buildRedMock,
  loadNodeType,
  instantiateNode,
  type MockNode,
  type MockRED,
} from "../helpers/red-mock";
import type {
  AttributeChangedEvent,
  AttributeChangeHandler,
  EventTriggeredEvent,
  EventTriggeredHandler,
} from "../../src/lib/controller-manager";

const MODULE_PATH = path.resolve(
  __dirname,
  "../../src/nodes/matter-subscribe/matter-subscribe",
);

function buildManagerMock() {
  // Capture the handlers registered by the node so we can invoke them directly
  const attrHandlers = new Map<string, AttributeChangeHandler[]>();
  const evtHandlers  = new Map<string, EventTriggeredHandler[]>();

  return {
    addAttributeHandler: jest.fn(async (nodeId: string, h: AttributeChangeHandler) => {
      if (!attrHandlers.has(nodeId)) attrHandlers.set(nodeId, []);
      attrHandlers.get(nodeId)!.push(h);
    }),
    removeAttributeHandler: jest.fn((nodeId: string, h: AttributeChangeHandler) => {
      const list = attrHandlers.get(nodeId) ?? [];
      attrHandlers.set(nodeId, list.filter((x) => x !== h));
    }),
    addEventHandler: jest.fn(async (nodeId: string, h: EventTriggeredHandler) => {
      if (!evtHandlers.has(nodeId)) evtHandlers.set(nodeId, []);
      evtHandlers.get(nodeId)!.push(h);
    }),
    removeEventHandler: jest.fn((nodeId: string, h: EventTriggeredHandler) => {
      const list = evtHandlers.get(nodeId) ?? [];
      evtHandlers.set(nodeId, list.filter((x) => x !== h));
    }),
    /** Simulate an attribute event arriving from the device */
    fireAttribute(nodeId: string, event: AttributeChangedEvent) {
      attrHandlers.get(nodeId)?.forEach((h) => h(event));
    },
    /** Simulate a triggered event arriving from the device */
    fireEvent(nodeId: string, event: EventTriggeredEvent) {
      evtHandlers.get(nodeId)?.forEach((h) => h(event));
    },
  };
}

function buildControllerNode(manager: ReturnType<typeof buildManagerMock>) {
  return { id: "ctrl1", manager };
}

function setup(config: Partial<{
  nodeId: string;
  endpointId: string;
  clusterId: string;
  attributeName: string;
  eventName: string;
}> = {}) {
  const manager = buildManagerMock();
  const controllerNode = buildControllerNode(manager);
  const nodes = new Map<string, unknown>([["ctrl1", controllerNode]]);
  const red = buildRedMock(nodes);
  const ctor = loadNodeType(MODULE_PATH, "matter-subscribe", red);

  const nodeInstance = instantiateNode(ctor, {
    id:            "sub1",
    type:          "matter-subscribe",
    name:          "",
    controller:    "ctrl1",
    nodeId:        config.nodeId      ?? "12345",
    endpointId:    config.endpointId  ?? "",
    clusterId:     config.clusterId   ?? "",
    attributeName: config.attributeName ?? "",
    eventName:     config.eventName   ?? "",
  });

  return { nodeInstance, manager, red };
}

const BASE_ATTR: AttributeChangedEvent = {
  nodeId:        "12345",
  endpointId:    1,
  clusterId:     6,
  attributeName: "onOff",
  value:         true,
  timestamp:     "2025-01-01T00:00:00.000Z",
};

const BASE_EVT: EventTriggeredEvent = {
  nodeId:     "12345",
  endpointId: 1,
  clusterId:  0x0101,
  eventName:  "DoorLockAlarm",
  events:     [{ alarmCode: 0 }],
  timestamp:  "2025-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------

describe("matter-subscribe — missing config", () => {
  it("calls this.error when no controller is configured", () => {
    const red = buildRedMock(); // no nodes
    const ctor = loadNodeType(MODULE_PATH, "matter-subscribe", red);
    const node = instantiateNode(ctor, {
      id: "sub1", type: "matter-subscribe", name: "",
      controller: "nonexistent", nodeId: "12345",
      endpointId: "", clusterId: "", attributeName: "", eventName: "",
    });
    expect(node.error).toHaveBeenCalled();
  });

  it("calls this.error when nodeId is empty", () => {
    const manager = buildManagerMock();
    const nodes = new Map<string, unknown>([["ctrl1", { id: "ctrl1", manager }]]);
    const red = buildRedMock(nodes);
    const ctor = loadNodeType(MODULE_PATH, "matter-subscribe", red);
    const node = instantiateNode(ctor, {
      id: "sub1", type: "matter-subscribe", name: "",
      controller: "ctrl1", nodeId: "",
      endpointId: "", clusterId: "", attributeName: "", eventName: "",
    });
    expect(node.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("matter-subscribe — attribute handler with no filters", () => {
  it("forwards every attribute change as a message", async () => {
    const { nodeInstance, manager } = setup();
    // Let the internal Promise chain resolve
    await Promise.resolve();

    manager.fireAttribute("12345", BASE_ATTR);
    expect(nodeInstance.send).toHaveBeenCalledTimes(1);
    const msg = (nodeInstance.send as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(msg.topic).toBe("onOff");
    expect((msg.payload as Record<string, unknown>).type).toBe("attribute");
    expect((msg.payload as Record<string, unknown>).value).toBe(true);
    expect(typeof (msg.payload as Record<string, unknown>).timestamp).toBe("string");
  });
});

// ---------------------------------------------------------------------------

describe("matter-subscribe — endpointId filter", () => {
  it("passes events whose endpointId matches the filter", async () => {
    const { nodeInstance, manager } = setup({ endpointId: "1" });
    await Promise.resolve();

    manager.fireAttribute("12345", { ...BASE_ATTR, endpointId: 1 });
    expect(nodeInstance.send).toHaveBeenCalledTimes(1);
  });

  it("drops events whose endpointId does not match the filter", async () => {
    const { nodeInstance, manager } = setup({ endpointId: "1" });
    await Promise.resolve();

    manager.fireAttribute("12345", { ...BASE_ATTR, endpointId: 2 });
    expect(nodeInstance.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("matter-subscribe — clusterId filter (hex)", () => {
  it("passes events whose clusterId matches the hex filter", async () => {
    const { nodeInstance, manager } = setup({ clusterId: "6" }); // hex 6 = decimal 6
    await Promise.resolve();

    manager.fireAttribute("12345", { ...BASE_ATTR, clusterId: 6 });
    expect(nodeInstance.send).toHaveBeenCalledTimes(1);
  });

  it("drops events whose clusterId does not match", async () => {
    const { nodeInstance, manager } = setup({ clusterId: "6" });
    await Promise.resolve();

    manager.fireAttribute("12345", { ...BASE_ATTR, clusterId: 0x0008 });
    expect(nodeInstance.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("matter-subscribe — attributeName filter", () => {
  it("passes events whose attributeName matches the filter", async () => {
    const { nodeInstance, manager } = setup({ attributeName: "onOff" });
    await Promise.resolve();

    manager.fireAttribute("12345", { ...BASE_ATTR, attributeName: "onOff" });
    expect(nodeInstance.send).toHaveBeenCalledTimes(1);
  });

  it("drops events with a different attributeName", async () => {
    const { nodeInstance, manager } = setup({ attributeName: "onOff" });
    await Promise.resolve();

    manager.fireAttribute("12345", { ...BASE_ATTR, attributeName: "currentLevel" });
    expect(nodeInstance.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("matter-subscribe — eventName filter", () => {
  it("passes triggered events whose eventName matches", async () => {
    const { nodeInstance, manager } = setup({ eventName: "DoorLockAlarm" });
    await Promise.resolve();

    manager.fireEvent("12345", BASE_EVT);
    expect(nodeInstance.send).toHaveBeenCalledTimes(1);
    const msg = (nodeInstance.send as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(msg.topic).toBe("DoorLockAlarm");
    expect((msg.payload as Record<string, unknown>).type).toBe("event");
  });

  it("drops triggered events whose eventName does not match", async () => {
    const { nodeInstance, manager } = setup({ eventName: "LockOperation" });
    await Promise.resolve();

    manager.fireEvent("12345", BASE_EVT); // eventName = "DoorLockAlarm"
    expect(nodeInstance.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("matter-subscribe — message payload structure", () => {
  it("attribute message includes all required fields", async () => {
    const { nodeInstance, manager } = setup();
    await Promise.resolve();

    manager.fireAttribute("12345", BASE_ATTR);
    const msg = (nodeInstance.send as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    const payload = msg.payload as Record<string, unknown>;

    expect(payload.type).toBe("attribute");
    expect(payload.nodeId).toBe("12345");
    expect(payload.endpointId).toBe(1);
    expect(payload.clusterId).toBe(6);
    expect(payload.attributeName).toBe("onOff");
    expect(payload.value).toBe(true);
    expect(payload.timestamp).toBe("2025-01-01T00:00:00.000Z");
  });

  it("event message includes all required fields", async () => {
    const { nodeInstance, manager } = setup();
    await Promise.resolve();

    manager.fireEvent("12345", BASE_EVT);
    const msg = (nodeInstance.send as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    const payload = msg.payload as Record<string, unknown>;

    expect(payload.type).toBe("event");
    expect(payload.nodeId).toBe("12345");
    expect(payload.endpointId).toBe(1);
    expect(payload.clusterId).toBe(0x0101);
    expect(payload.eventName).toBe("DoorLockAlarm");
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.timestamp).toBe("2025-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------

describe("matter-subscribe — close removes handlers", () => {
  it("removes attribute and event handlers on close", async () => {
    const { nodeInstance, manager } = setup();
    await Promise.resolve();

    const done = jest.fn();
    nodeInstance.emit("close", false, done);

    expect(manager.removeAttributeHandler).toHaveBeenCalledTimes(1);
    expect(manager.removeEventHandler).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalled();
  });
});
