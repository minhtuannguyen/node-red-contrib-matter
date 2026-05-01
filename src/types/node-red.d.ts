// Minimal type declarations for Node-RED API.
// These cover what we need for building Node-RED nodes in TypeScript.

export interface NodeRedNode {
  id: string;
  type: string;
  name: string;
  credentials?: Record<string, string>;
  send(msg: NodeRedMessage | NodeRedMessage[]): void;
  status(opts: NodeRedStatus): void;
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string, originalMsg?: NodeRedMessage): void;
  debug(msg: string): void;
  trace(msg: string): void;
  on(event: "input", callback: (msg: NodeRedMessage, send: (msg: NodeRedMessage) => void, done: (err?: Error) => void) => void): void;
  on(event: "close", callback: (removed: boolean, done: () => void) => void): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
}

export interface NodeRedMessage {
  payload?: unknown;
  topic?: string;
  [key: string]: unknown;
}

export interface NodeRedStatus {
  fill?: "red" | "green" | "yellow" | "blue" | "grey";
  shape?: "dot" | "ring";
  text?: string;
}

export interface NodeRedDef {
  id: string;
  type: string;
  name: string;
  wires?: string[][];
  z?: string;
}

export interface NodeRedAPI {
  nodes: {
    registerType(
      name: string,
      // Node-RED constructor functions are called with `new` but typed as plain functions
      // (TypeScript disallows `this` params in constructors)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor: new (...args: any[]) => void,
      opts?: { credentials?: Record<string, { type: string }> }
    ): void;
    createNode(node: NodeRedNode, config: NodeRedDef): void;
    getNode(id: string): NodeRedNode | null;
  };
  log: {
    FATAL: number;
    ERROR: number;
    WARN: number;
    INFO: number;
    DEBUG: number;
    TRACE: number;
  };
  settings: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  httpAdmin: {
    get(path: string, ...handlers: ((req: any, res: any, next?: any) => void)[]): void;
  };
}
