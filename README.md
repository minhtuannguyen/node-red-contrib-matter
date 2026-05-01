# node-red-contrib-matter

A generic [Matter](https://csa-iot.org/all-solutions/matter/) protocol controller for [Node-RED](https://nodered.org/).  
Commission and control **any Matter device** — smart locks, lights, sensors — directly from Node-RED flows over IP or Thread.

Built on [matter.js](https://github.com/project-chip/matter.js) (`@project-chip/matter.js`).

---

## Features

- **Commission** any Matter device into your own fabric (multi-admin alongside Apple Home, Google Home, etc.)
- **Send commands** to any cluster and endpoint (lock/unlock, on/off, scenes, …)
- **Read attributes** on demand (lock state, brightness, temperature, …)
- **Subscribe** to real-time attribute changes and events
- Works on **Raspberry Pi** (Ethernet or WiFi) and any Node.js-capable Linux/macOS host
- Thread devices reachable via a Thread Border Router (HomePod, Apple TV, OTBR)

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20.0.0 |
| Node-RED | ≥ 3.0.0 |

---

## Installation

### From GitHub

```bash
cd ~/.node-red
npm install github:minhtuannguyen/node-red-contrib-matter
```

### From a local clone

```bash
# On the target machine:
git clone https://github.com/minhtuannguyen/node-red-contrib-matter.git
cd ~/.node-red
npm install ../node-red-contrib-matter
```

> **Note:** The compiled `dist/` folder is included in the repository, so no TypeScript compiler is needed on the target machine.

Then restart Node-RED:

```bash
node-red-restart
# or
sudo systemctl restart nodered
```

---

## Nodes

### `matter-controller` (config node)

Shared configuration node. Manages the Matter controller lifecycle — one per Node-RED instance.

| Property | Description | Default |
|---|---|---|
| Storage Path | Directory where fabric credentials are persisted | `~/.node-red-matter` |
| UDP Port | Matter controller port | `5540` |
| Log Level | matter.js log verbosity | `Info` |

---

### `matter-commission`

Commission a Matter device into the Node-RED controller fabric.

**Input `msg.payload`:**

| Field | Type | Description |
|---|---|---|
| `pairingCode` | string | 11-digit manual pairing code (hyphens optional). Overrides node config. |
| `knownAddress` | string | *(optional)* IPv6/IPv4 address to skip mDNS discovery. Useful for Thread devices. |

**Output `msg.payload`:**

```json
{ "nodeId": "<commissioned-node-id>", "endpoints": [...] }
```

> Before commissioning, open a commissioning window from your primary controller:  
> **Apple Home** → device → ⚙️ → *Turn on Pairing Mode*

---

### `matter-discover`

Discovers all endpoints, clusters, attributes, and commands of a commissioned device. Use this once after commissioning to learn what the device supports.

**Input:** any message (triggers the discovery).  
Override `nodeId` at runtime via `msg.nodeId`.

**Output `msg.payload`:**

```json
{
  "nodeId": "<commissioned-node-id>",
  "endpoints": [
    {
      "endpointId": 0,
      "clusters": [
        {
          "clusterId": 40,
          "clusterIdHex": "0028",
          "clusterName": "BasicInformation",
          "attributes": ["vendorName", "productName", "serialNumber", ...],
          "commands": []
        }
      ]
    },
    {
      "endpointId": 1,
      "clusters": [
        {
          "clusterId": 47,
          "clusterIdHex": "002F",
          "clusterName": "PowerSource",
          "attributes": ["batPercentRemaining", "batVoltage", "batChargeLevel", ...],
          "commands": []
        },
        {
          "clusterId": 257,
          "clusterIdHex": "0101",
          "clusterName": "DoorLock",
          "attributes": ["lockState", "lockType", "doorState", ...],
          "commands": ["lockDoor", "unlockDoor", "unlockWithTimeout", ...]
        }
      ]
    }
  ]
}
```

Connect the output to a Debug node set to **"complete msg object"** to inspect the full structure.  
Use the `clusterIdHex` and attribute/command names directly in the other nodes.



Send a command to a cluster on a commissioned device.

**Config / `msg` overrides:**

| Field | Description | Example |
|---|---|---|
| `nodeId` | Commissioned node ID | `1` |
| `endpointId` | Endpoint number | `1` |
| `clusterId` | Cluster ID (hex) | `0101` (DoorLock) |
| `commandName` | Command name (camelCase) | `lockDoor`, `unlockDoor` |
| `payload` | Command arguments object | `{ "timeout": 30 }` |

All fields can be overridden at runtime via `msg.nodeId`, `msg.endpointId`, `msg.clusterId`, `msg.commandName`, `msg.payload`.

---

### `matter-read`

Read an attribute value from a commissioned device on any input message.

| Field | Description | Example |
|---|---|---|
| `nodeId` | Commissioned node ID | `1` |
| `endpointId` | Endpoint number | `1` |
| `clusterId` | Cluster ID (hex) | `0101` |
| `attributeName` | Attribute name (camelCase) | `lockState` |

**Output `msg.payload`:** the raw attribute value.

---

### `matter-subscribe`

Subscribes to real-time attribute changes and/or events from a device. Starts automatically on deploy, no input needed.

| Field | Description | Example |
|---|---|---|
| `nodeId` | Commissioned node ID | `1` |
| `endpointId` | *(optional)* Filter by endpoint | `1` |
| `clusterId` | *(optional)* Filter by cluster (hex) | `0101` |
| `attributeName` | *(optional)* Filter by attribute | `lockState` |
| `eventName` | *(optional)* Filter by event | `doorLockAlarm` |

Leave filter fields blank to receive all changes from the node.

**Output `msg.payload` — attribute change:**
```json
{
  "type": "attribute",
  "nodeId": "1",
  "endpointId": 1,
  "clusterId": 257,
  "attributeName": "lockState",
  "value": 1,
  "timestamp": "2026-05-01T17:00:00.000Z"
}
```

**Output `msg.payload` — event:**
```json
{
  "type": "event",
  "nodeId": "1",
  "endpointId": 1,
  "clusterId": 257,
  "eventName": "doorLockAlarm",
  "events": [...],
  "timestamp": "2026-05-01T17:00:00.000Z"
}
```

---

## Example: Nuki Smart Lock

Import `examples/nuki-lock.json` into Node-RED for a ready-made flow covering:

1. Commission the lock (one-time)
2. Lock / Unlock / Unlock with timeout
3. Read `lockState` on demand
4. Subscribe to `lockState` changes and `doorLockAlarm` events

**DoorLock cluster reference:**

| Property | Value |
|---|---|
| Cluster ID | `0101` |
| Endpoint | `1` |
| Commands | `lockDoor`, `unlockDoor`, `unlockWithTimeout` |
| `lockState` values | `0` = NotFullyLocked, `1` = Locked, `2` = Unlocked, `3` = Unlatched |

**Battery level (PowerSource cluster):**

| Property | Value |
|---|---|
| Cluster ID | `002F` |
| Endpoint | `1` |
| Attribute | `batPercentRemaining` |
| Raw value | 0–200 (divide by 2 for %) — e.g. `170` → 85% |
| `batChargeLevel` | `0` = OK, `1` = Warning, `2` = Critical |

Add a Function node after `matter-read` to convert the raw value:
```javascript
msg.payload = msg.payload / 2;  // e.g. 170 → 85
return msg;
```

---

## Thread devices (HomePod, Apple TV as Border Router)

If your device is Thread-only (e.g. Nuki Smart Lock connected via HomePod), standard mDNS commissioning discovery won't bridge from Thread to your WiFi/Ethernet network. Pass the device's IPv6 address directly:

```json
{
  "pairingCode": "1234-567-8901",
  "knownAddress": "fd00::1234"
}
```

Find the IPv6 address using `avahi-browse -rt _matterc._udp` (Linux) or `dns-sd -B _matterc._udp local` (macOS) while the commissioning window is open.

---

## Development

```bash
git clone https://github.com/minhtuannguyen/node-red-contrib-matter.git
cd node-red-contrib-matter
npm install
npm run build       # compile TypeScript → dist/
npm run dev         # watch mode
```

Install as a live symlink into Node-RED for development:

```bash
cd ~/.node-red/node_modules
ln -s /path/to/node-red-contrib-matter node-red-contrib-matter
```

---

## License

Apache 2.0
