/**
 * Tests for the matter-discover node.
 */

import path from "path";
import { buildRedMock, loadNodeType, instantiateNode } from "../helpers/red-mock";
import type { DeviceDescription } from "../../src/lib/controller-manager";

const MODULE_PATH = path.resolve(
  __dirname,
  "../../src/nodes/matter-discover/matter-discover",
);

const SAMPLE_DESCRIPTION: DeviceDescription = {
  nodeId: "12345",
  endpoints: [
    {
      endpointId: 0,
      clusters: [
        {
          clusterId:    0x0028,
          clusterIdHex: "0028",
          clusterName:  "BasicInformation",
          attributes:   ["vendorName", "productName"],
          commands:     [],
          events:       [],
        },
      ],
    },
    {
      endpointId: 1,
      clusters: [
        {
          clusterId:    0x0006,
          clusterIdHex: "0006",
          clusterName:  "OnOff",
          attributes:   ["onOff"],
          commands:     ["on", "off", "toggle"],
          events:       [],
        },
      ],
    },
  ],
};

function buildManagerMock() {
  return {
    registerDevice:  jest.fn().mockResolvedValue(undefined),
    discoverDevice:  jest.fn().mockResolvedValue(SAMPLE_DESCRIPTION),
    getRegistry: jest.fn().mockReturnValue({
      "12345": {
        label:        "Test Device",
        nodeId:       "12345",
        discoveredAt: "2025-01-01T00:00:00.000Z",
        discovery:    SAMPLE_DESCRIPTION,
      },
    }),
  };
}

function setup(configOverrides: Record<string, unknown> = {}) {
  const manager = buildManagerMock();
  const nodes = new Map<string, unknown>([["ctrl1", { id: "ctrl1", manager }]]);
  const red = buildRedMock(nodes);
  const ctor = loadNodeType(MODULE_PATH, "matter-discover", red);

  const nodeInstance = instantiateNode(ctor, {
    id:         "disc1",
    type:       "matter-discover",
    name:       "",
    controller: "ctrl1",
    nodeId:     "12345",
    ...configOverrides,
  });

  return { nodeInstance, manager };
}

// ---------------------------------------------------------------------------

describe("matter-discover — missing controller", () => {
  it("calls this.error when controller is not found", () => {
    const red = buildRedMock();
    const ctor = loadNodeType(MODULE_PATH, "matter-discover", red);
    const node = instantiateNode(ctor, {
      id: "d1", type: "matter-discover", name: "",
      controller: "nope", nodeId: "12345",
    });
    expect(node.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("matter-discover — nodeId validation", () => {
  it("calls done(error) when nodeId is missing from both config and msg", async () => {
    const { nodeInstance } = setup({ nodeId: "" });
    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), done);
    await new Promise((r) => setImmediate(r));
    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ---------------------------------------------------------------------------

describe("matter-discover — successful discovery", () => {
  it("calls registerDevice with the nodeId", async () => {
    const { nodeInstance, manager } = setup();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), jest.fn());
    await new Promise((r) => setImmediate(r));
    expect(manager.registerDevice).toHaveBeenCalledWith("12345");
  });

  it("sends DeviceDescription from registry as payload", async () => {
    const { nodeInstance } = setup();
    const send = jest.fn();
    nodeInstance.emit("input", { payload: {} }, send, jest.fn());
    await new Promise((r) => setImmediate(r));

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as Record<string, unknown>;
    const description = msg.payload as DeviceDescription;
    expect(description.nodeId).toBe("12345");
    expect(description.endpoints).toHaveLength(2);
  });

  it("sets msg.topic to 'discover:<nodeId>'", async () => {
    const { nodeInstance } = setup();
    const send = jest.fn();
    nodeInstance.emit("input", { payload: {} }, send, jest.fn());
    await new Promise((r) => setImmediate(r));

    const msg = send.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.topic).toBe("discover:12345");
  });

  it("msg.nodeId overrides config nodeId", async () => {
    const { nodeInstance, manager } = setup();

    // update registry to have the override nodeId
    manager.getRegistry.mockReturnValue({
      "99999": {
        label:        "Other Device",
        nodeId:       "99999",
        discoveredAt: "2025-01-01T00:00:00.000Z",
        discovery:    { ...SAMPLE_DESCRIPTION, nodeId: "99999" },
      },
    });

    nodeInstance.emit(
      "input",
      { payload: {}, nodeId: "99999" },
      jest.fn(),
      jest.fn(),
    );
    await new Promise((r) => setImmediate(r));

    expect(manager.registerDevice).toHaveBeenCalledWith("99999");
  });
});

// ---------------------------------------------------------------------------

describe("matter-discover — registerDevice failure", () => {
  it("calls done(error) when registerDevice rejects", async () => {
    const { nodeInstance, manager } = setup();
    manager.registerDevice.mockRejectedValue(new Error("device offline"));

    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), done);
    await new Promise((r) => setImmediate(r));

    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
});
