/**
 * Tests for the matter-command node.
 */

import path from "path";
import { buildRedMock, loadNodeType, instantiateNode, type MockNode } from "../helpers/red-mock";

const MODULE_PATH = path.resolve(
  __dirname,
  "../../src/nodes/matter-command/matter-command",
);

function buildManagerMock() {
  return {
    invokeCommand: jest.fn().mockResolvedValue(null),
  };
}

function setup(configOverrides: Record<string, unknown> = {}) {
  const manager = buildManagerMock();
  const nodes = new Map<string, unknown>([["ctrl1", { id: "ctrl1", manager }]]);
  const red = buildRedMock(nodes);
  const ctor = loadNodeType(MODULE_PATH, "matter-command", red);

  const nodeInstance = instantiateNode(ctor, {
    id:          "cmd1",
    type:        "matter-command",
    name:        "",
    controller:  "ctrl1",
    nodeId:      "12345",
    endpointId:  "1",
    clusterId:   "6",
    commandName: "toggle",
    ...configOverrides,
  });

  return { nodeInstance, manager };
}

// ---------------------------------------------------------------------------

describe("matter-command — missing controller", () => {
  it("calls this.error and returns when controller is not found", () => {
    const red = buildRedMock(); // empty node registry
    const ctor = loadNodeType(MODULE_PATH, "matter-command", red);
    const node = instantiateNode(ctor, {
      id: "cmd1", type: "matter-command", name: "",
      controller: "nonexistent", nodeId: "12345",
      endpointId: "1", clusterId: "6", commandName: "toggle",
    });
    expect(node.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("matter-command — input validation", () => {
  it("calls done(error) when nodeId is missing", async () => {
    const { nodeInstance } = setup({ nodeId: "" });

    const send = jest.fn();
    const done = jest.fn();
    await nodeInstance.emit("input", { payload: {} }, send, done);
    await Promise.resolve();

    expect(done).toHaveBeenCalledWith(expect.any(Error));
    expect(send).not.toHaveBeenCalled();
  });

  it("calls done(error) when commandName is missing", async () => {
    const { nodeInstance } = setup({ commandName: "" });

    const send = jest.fn();
    const done = jest.fn();
    await nodeInstance.emit("input", { payload: {} }, send, done);
    await Promise.resolve();

    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });

  it("calls done(error) when endpointId is NaN", async () => {
    const { nodeInstance } = setup({ endpointId: "not-a-number" });

    const send = jest.fn();
    const done = jest.fn();
    await nodeInstance.emit("input", { payload: {} }, send, done);
    await Promise.resolve();

    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ---------------------------------------------------------------------------

describe("matter-command — successful invocation", () => {
  it("calls invokeCommand with config values", async () => {
    const { nodeInstance, manager } = setup();
    manager.invokeCommand.mockResolvedValue(undefined);

    const send = jest.fn();
    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, send, done);
    await new Promise((r) => setImmediate(r));

    expect(manager.invokeCommand).toHaveBeenCalledWith(
      "12345", 1, 6, "toggle", {},
    );
    expect(done).toHaveBeenCalledWith(); // done() with no error
  });

  it("sends result as msg.payload and commandName as topic", async () => {
    const { nodeInstance, manager } = setup();
    manager.invokeCommand.mockResolvedValue({ status: "ok" });

    const send = jest.fn();
    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, send, done);
    await new Promise((r) => setImmediate(r));

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.payload).toEqual({ status: "ok" });
    expect(msg.topic).toBe("toggle");
  });

  it("passes msg.payload object as command args", async () => {
    const { nodeInstance, manager } = setup();

    const send = jest.fn();
    const done = jest.fn();
    nodeInstance.emit("input", { payload: { level: 50 } }, send, done);
    await new Promise((r) => setImmediate(r));

    expect(manager.invokeCommand).toHaveBeenCalledWith(
      "12345", 1, 6, "toggle", { level: 50 },
    );
  });

  it("per-message overrides for nodeId / endpointId / clusterId / commandName", async () => {
    const { nodeInstance, manager } = setup();

    const send = jest.fn();
    const done = jest.fn();
    nodeInstance.emit(
      "input",
      {
        payload: {},
        nodeId:      "99999",
        endpointId:  "2",
        clusterId:   "8",
        commandName: "moveToLevel",
      },
      send,
      done,
    );
    await new Promise((r) => setImmediate(r));

    expect(manager.invokeCommand).toHaveBeenCalledWith(
      "99999", 2, 8, "moveToLevel", {},
    );
  });
});

// ---------------------------------------------------------------------------

describe("matter-command — invokeCommand failure", () => {
  it("calls done(error) and does not send when invokeCommand rejects", async () => {
    const { nodeInstance, manager } = setup();
    manager.invokeCommand.mockRejectedValue(new Error("cluster not found"));

    const send = jest.fn();
    const done = jest.fn();
    nodeInstance.emit("input", { payload: {} }, send, done);
    await new Promise((r) => setImmediate(r));

    expect(done).toHaveBeenCalledWith(expect.any(Error));
    expect(send).not.toHaveBeenCalled();
  });
});
