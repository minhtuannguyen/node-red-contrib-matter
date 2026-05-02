/**
 * Tests for the matter-read node.
 */

import path from "path";
import { buildRedMock, loadNodeType, instantiateNode } from "../helpers/red-mock";

const MODULE_PATH = path.resolve(
  __dirname,
  "../../src/nodes/matter-read/matter-read",
);

function buildManagerMock() {
  return { readAttribute: jest.fn().mockResolvedValue(42) };
}

function setup(configOverrides: Record<string, unknown> = {}) {
  const manager = buildManagerMock();
  const nodes = new Map<string, unknown>([["ctrl1", { id: "ctrl1", manager }]]);
  const red = buildRedMock(nodes);
  const ctor = loadNodeType(MODULE_PATH, "matter-read", red);

  const nodeInstance = instantiateNode(ctor, {
    id:            "read1",
    type:          "matter-read",
    name:          "",
    controller:    "ctrl1",
    nodeId:        "12345",
    endpointId:    "1",
    clusterId:     "402",  // TemperatureMeasurement in hex
    attributeName: "measuredValue",
    ...configOverrides,
  });

  return { nodeInstance, manager };
}

// ---------------------------------------------------------------------------

describe("matter-read — missing controller", () => {
  it("calls this.error when controller is not found", () => {
    const red = buildRedMock();
    const ctor = loadNodeType(MODULE_PATH, "matter-read", red);
    const node = instantiateNode(ctor, {
      id: "read1", type: "matter-read", name: "",
      controller: "nope", nodeId: "12345",
      endpointId: "1", clusterId: "402", attributeName: "measuredValue",
    });
    expect(node.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("matter-read — input validation", () => {
  it("calls done(error) when nodeId is missing", async () => {
    const { nodeInstance } = setup({ nodeId: "" });
    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), done);
    await new Promise((r) => setImmediate(r));
    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });

  it("calls done(error) when attributeName is missing", async () => {
    const { nodeInstance } = setup({ attributeName: "" });
    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), done);
    await new Promise((r) => setImmediate(r));
    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });

  it("calls done(error) when endpointId is NaN", async () => {
    const { nodeInstance } = setup({ endpointId: "bad" });
    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), done);
    await new Promise((r) => setImmediate(r));
    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ---------------------------------------------------------------------------

describe("matter-read — successful read", () => {
  it("calls readAttribute with correct params derived from config", async () => {
    const { nodeInstance, manager } = setup();

    const send = jest.fn();
    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, send, done);
    await new Promise((r) => setImmediate(r));

    // clusterId "402" parsed as hex → 1026
    expect(manager.readAttribute).toHaveBeenCalledWith("12345", 1, 0x402, "measuredValue");
    expect(done).toHaveBeenCalledWith();
  });

  it("sends attribute value as msg.payload and attributeName as topic", async () => {
    const { nodeInstance, manager } = setup();
    manager.readAttribute.mockResolvedValue(2350); // 23.50 °C

    const send = jest.fn();
    nodeInstance.emit("input", { payload: {} }, send, jest.fn());
    await new Promise((r) => setImmediate(r));

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.payload).toBe(2350);
    expect(msg.topic).toBe("measuredValue");
  });

  it("per-message overrides for nodeId / endpointId / clusterId / attributeName", async () => {
    const { nodeInstance, manager } = setup();

    nodeInstance.emit(
      "input",
      {
        payload:       {},
        nodeId:        "99999",
        endpointId:    "2",
        clusterId:     "405",
        attributeName: "measuredValue",
      },
      jest.fn(),
      jest.fn(),
    );
    await new Promise((r) => setImmediate(r));

    expect(manager.readAttribute).toHaveBeenCalledWith("99999", 2, 0x405, "measuredValue");
  });
});

// ---------------------------------------------------------------------------

describe("matter-read — readAttribute failure", () => {
  it("calls done(error) when readAttribute rejects", async () => {
    const { nodeInstance, manager } = setup();
    manager.readAttribute.mockRejectedValue(new Error("attribute not found"));

    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), done);
    await new Promise((r) => setImmediate(r));

    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
});
