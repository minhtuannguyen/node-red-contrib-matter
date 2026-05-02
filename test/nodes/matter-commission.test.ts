/**
 * Tests for the matter-commission node.
 */

import path from "path";
import { buildRedMock, loadNodeType, instantiateNode } from "../helpers/red-mock";

const MODULE_PATH = path.resolve(
  __dirname,
  "../../src/nodes/matter-commission/matter-commission",
);

function buildManagerMock() {
  return {
    commission: jest.fn().mockResolvedValue({ nodeId: "12345", endpoints: [] }),
  };
}

function setup(configOverrides: Record<string, unknown> = {}) {
  const manager = buildManagerMock();
  const nodes = new Map<string, unknown>([["ctrl1", { id: "ctrl1", manager }]]);
  const red = buildRedMock(nodes);
  const ctor = loadNodeType(MODULE_PATH, "matter-commission", red);

  const nodeInstance = instantiateNode(ctor, {
    id:          "comm1",
    type:        "matter-commission",
    name:        "",
    controller:  "ctrl1",
    pairingCode: "",   // default empty — must come from msg or config
    deviceName:  "",
    ...configOverrides,
  });

  return { nodeInstance, manager };
}

// ---------------------------------------------------------------------------

describe("matter-commission — missing controller", () => {
  it("calls this.error when controller is not found", () => {
    const red = buildRedMock();
    const ctor = loadNodeType(MODULE_PATH, "matter-commission", red);
    const node = instantiateNode(ctor, {
      id: "comm1", type: "matter-commission", name: "",
      controller: "nope", pairingCode: "", deviceName: "",
    });
    expect(node.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("matter-commission — pairing code validation", () => {
  it("calls done(error) when no pairingCode is provided", async () => {
    const { nodeInstance } = setup();
    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, jest.fn(), done);
    await new Promise((r) => setImmediate(r));
    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ---------------------------------------------------------------------------

describe("matter-commission — successful commissioning", () => {
  it("uses msg.payload.pairingCode over the config value", async () => {
    const { nodeInstance, manager } = setup({ pairingCode: "00000000000" });

    const send = jest.fn();
    const done = jest.fn();
    nodeInstance.emit(
      "input",
      { payload: { pairingCode: "12345678901" } },
      send,
      done,
    );
    await new Promise((r) => setImmediate(r));

    expect(manager.commission).toHaveBeenCalledWith(
      "12345678901", undefined, undefined,
    );
    expect(done).toHaveBeenCalledWith();
  });

  it("strips hyphens from the pairing code", async () => {
    const { nodeInstance, manager } = setup();

    nodeInstance.emit(
      "input",
      { payload: { pairingCode: "1234-567-8901" } },
      jest.fn(),
      jest.fn(),
    );
    await new Promise((r) => setImmediate(r));

    expect(manager.commission).toHaveBeenCalledWith(
      "1234-567-8901".replace(/-/g, ""), undefined, undefined,
    );
  });

  it("passes msg.payload.deviceName to commission()", async () => {
    const { nodeInstance, manager } = setup();

    nodeInstance.emit(
      "input",
      { payload: { pairingCode: "12345678901", deviceName: "My Lock" } },
      jest.fn(),
      jest.fn(),
    );
    await new Promise((r) => setImmediate(r));

    expect(manager.commission).toHaveBeenCalledWith(
      "12345678901", undefined, "My Lock",
    );
  });

  it("passes msg.payload.knownAddress to commission()", async () => {
    const { nodeInstance, manager } = setup();

    nodeInstance.emit(
      "input",
      { payload: { pairingCode: "12345678901", knownAddress: "192.168.1.50" } },
      jest.fn(),
      jest.fn(),
    );
    await new Promise((r) => setImmediate(r));

    expect(manager.commission).toHaveBeenCalledWith(
      "12345678901", "192.168.1.50", undefined,
    );
  });

  it("sends NodeInfo as payload and 'commissioned' as topic", async () => {
    const { nodeInstance, manager } = setup();
    manager.commission.mockResolvedValue({ nodeId: "42", endpoints: [] });

    const send = jest.fn();
    nodeInstance.emit(
      "input",
      { payload: { pairingCode: "12345678901" } },
      send,
      jest.fn(),
    );
    await new Promise((r) => setImmediate(r));

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.payload).toEqual({ nodeId: "42", endpoints: [] });
    expect(msg.topic).toBe("commissioned");
  });
});

// ---------------------------------------------------------------------------

describe("matter-commission — commission failure", () => {
  it("calls done(error) and does not send on failure", async () => {
    const { nodeInstance, manager } = setup();
    manager.commission.mockRejectedValue(new Error("no device found"));

    const send = jest.fn();
    const done = jest.fn();
    nodeInstance.emit(
      "input",
      { payload: { pairingCode: "12345678901" } },
      send,
      done,
    );
    await new Promise((r) => setImmediate(r));

    expect(done).toHaveBeenCalledWith(expect.any(Error));
    expect(send).not.toHaveBeenCalled();
  });
});
