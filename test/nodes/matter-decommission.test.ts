/**
 * Tests for the matter-decommission node.
 */

import path from "path";
import { buildRedMock, loadNodeType, instantiateNode } from "../helpers/red-mock";

const MODULE_PATH = path.resolve(
  __dirname,
  "../../src/nodes/matter-decommission/matter-decommission",
);

function buildManagerMock() {
  return { removeDevice: jest.fn().mockResolvedValue(undefined) };
}

function setup(configOverrides: Record<string, unknown> = {}) {
  const manager = buildManagerMock();
  const nodes = new Map<string, unknown>([["ctrl1", { id: "ctrl1", manager }]]);
  const red = buildRedMock(nodes);
  const ctor = loadNodeType(MODULE_PATH, "matter-decommission", red);

  const nodeInstance = instantiateNode(ctor, {
    id:         "decomm1",
    type:       "matter-decommission",
    name:       "",
    controller: "ctrl1",
    nodeId:     "12345",
    force:      false,
    ...configOverrides,
  });

  return { nodeInstance, manager };
}

// ---------------------------------------------------------------------------

describe("matter-decommission — missing controller", () => {
  it("calls this.error when controller is not found", () => {
    const red = buildRedMock();
    const ctor = loadNodeType(MODULE_PATH, "matter-decommission", red);
    const node = instantiateNode(ctor, {
      id: "d1", type: "matter-decommission", name: "",
      controller: "nope", nodeId: "12345", force: false,
    });
    expect(node.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("matter-decommission — nodeId validation", () => {
  it("calls done(error) when nodeId is empty and not in msg", async () => {
    const { nodeInstance } = setup({ nodeId: "" });
    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), done);
    await new Promise((r) => setImmediate(r));
    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ---------------------------------------------------------------------------

describe("matter-decommission — successful removal", () => {
  it("calls removeDevice(nodeId, false) by default", async () => {
    const { nodeInstance, manager } = setup();

    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), done);
    await new Promise((r) => setImmediate(r));

    expect(manager.removeDevice).toHaveBeenCalledWith("12345", false);
    expect(done).toHaveBeenCalledWith();
  });

  it("passes force=true when config.force is true", async () => {
    const { nodeInstance, manager } = setup({ force: true });

    nodeInstance.emit("input", { payload: {} }, jest.fn(), jest.fn());
    await new Promise((r) => setImmediate(r));

    expect(manager.removeDevice).toHaveBeenCalledWith("12345", true);
  });

  it("msg.payload.force overrides config", async () => {
    const { nodeInstance, manager } = setup({ force: false });

    nodeInstance.emit("input", { payload: { force: true } }, jest.fn(), jest.fn());
    await new Promise((r) => setImmediate(r));

    expect(manager.removeDevice).toHaveBeenCalledWith("12345", true);
  });

  it("msg.payload.nodeId overrides config nodeId", async () => {
    const { nodeInstance, manager } = setup();

    nodeInstance.emit("input", { payload: { nodeId: "99999" } }, jest.fn(), jest.fn());
    await new Promise((r) => setImmediate(r));

    expect(manager.removeDevice).toHaveBeenCalledWith("99999", false);
  });

  it("sends ok:true and 'decommissioned' topic on success", async () => {
    const { nodeInstance } = setup();

    const send = jest.fn();
    nodeInstance.emit("input", { payload: {} }, send, jest.fn());
    await new Promise((r) => setImmediate(r));

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as Record<string, unknown>;
    expect((msg.payload as Record<string, unknown>).ok).toBe(true);
    expect(msg.topic).toBe("decommissioned");
  });
});

// ---------------------------------------------------------------------------

describe("matter-decommission — removeDevice failure", () => {
  it("calls done(error) on failure", async () => {
    const { nodeInstance, manager } = setup();
    manager.removeDevice.mockRejectedValue(new Error("device unreachable"));

    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), done);
    await new Promise((r) => setImmediate(r));

    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
});
