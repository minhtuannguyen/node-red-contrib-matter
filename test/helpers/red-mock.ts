/**
 * Minimal Node-RED API mock for unit tests.
 * Simulates RED.nodes.createNode(), RED.nodes.getNode(), RED.nodes.registerType()
 * and RED.httpAdmin.get() without starting a real Node-RED runtime.
 */

export interface MockNode {
  id: string;
  type: string;
  name: string;
  send: jest.Mock;
  error: jest.Mock;
  status: jest.Mock;
  log: jest.Mock;
  warn: jest.Mock;
  debug: jest.Mock;
  trace: jest.Mock;
  _handlers: Map<string, (...args: unknown[]) => void>;
  on(event: string, cb: (...args: unknown[]) => void): void;
  /** Trigger a registered event handler (e.g. "input", "close") */
  emit(event: string, ...args: unknown[]): void;
}

export interface MockRED {
  nodes: {
    createNode: jest.Mock;
    getNode: jest.Mock;
    registerType: jest.Mock;
  };
  httpAdmin: {
    get: jest.Mock;
  };
  /** Internal type registry populated by registerType() */
  _types: Map<string, new (...args: unknown[]) => void>;
  /** Internal node-id registry used by getNode() */
  _nodes: Map<string, unknown>;
}

/**
 * Build a fresh RED mock. Pass a pre-populated node map to make
 * RED.nodes.getNode() return specific controller nodes.
 */
export function buildRedMock(
  nodes: Map<string, unknown> = new Map(),
): MockRED {
  const registeredTypes = new Map<string, new (...args: unknown[]) => void>();

  const red: MockRED = {
    nodes: {
      createNode: jest.fn((nodeThis: MockNode, _config: unknown) => {
        // Attach the standard Node-RED node API to `this`
        nodeThis._handlers = new Map();
        nodeThis.on = (event: string, cb: (...args: unknown[]) => void) => {
          nodeThis._handlers.set(event, cb);
        };
        nodeThis.send  = jest.fn();
        nodeThis.error = jest.fn();
        nodeThis.status = jest.fn();
        nodeThis.log   = jest.fn();
        nodeThis.warn  = jest.fn();
        nodeThis.debug = jest.fn();
        nodeThis.trace = jest.fn();
        nodeThis.emit  = (event: string, ...args: unknown[]) => {
          nodeThis._handlers.get(event)?.(...args);
        };
      }),
      getNode: jest.fn((id: string) => nodes.get(id) ?? null),
      registerType: jest.fn(
        (name: string, ctor: new (...args: unknown[]) => void) => {
          registeredTypes.set(name, ctor);
        },
      ),
    },
    httpAdmin: {
      get: jest.fn(),
    },
    _types: registeredTypes,
    _nodes: nodes,
  };

  return red;
}

/**
 * Load a Node-RED node module and register it with the mock RED.
 * Returns the constructor function for the named node type.
 *
 * @param modulePath  Absolute or relative path to the node's .ts source file
 * @param typeName    The name passed to RED.nodes.registerType()
 * @param red         The mock RED instance
 */
export function loadNodeType(
  modulePath: string,
  typeName: string,
  red: MockRED,
): new (...args: unknown[]) => void {
  // Clear require cache so each test suite gets a fresh module
  delete require.cache[require.resolve(modulePath)];
  const nodeModule = require(modulePath) as (red: MockRED) => void;
  nodeModule(red);
  const ctor = red._types.get(typeName);
  if (!ctor) throw new Error(`Node type "${typeName}" was not registered`);
  return ctor;
}

/**
 * Construct a node instance by calling the registered constructor with a config.
 * Returns the node object (enriched by createNode mock with .send, .status, etc.)
 */
export function instantiateNode(
  ctor: new (...args: unknown[]) => void,
  config: Record<string, unknown>,
): MockNode {
  const instance = {} as MockNode;
  (ctor as unknown as (this: MockNode, cfg: Record<string, unknown>) => void).call(
    instance,
    config,
  );
  return instance;
}
