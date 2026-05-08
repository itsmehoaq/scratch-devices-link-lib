# `@monoblock/esp32-gateway`

Transport-agnostic JavaScript library for Monoblock ESP32 gateway boards.

This package provides:

- a polling client for dynamic module topology (`health`, `modules`, `sensors`)
- command APIs for LED control and generic I2C module read/write
- two transports:
  - HTTP transport for direct ESP32 AP/API access
  - VM serial transport for ScratchLink-style serial command channels
- Windify integration utilities to map scanned modules into GUI dropdown store shape

## Install

```bash
npm install @monoblock/esp32-gateway
```

## Quick Start (HTTP)

```js
import {
  MonoblockEsp32GatewayClient,
  createHttpTransport,
} from "@monoblock/esp32-gateway";

const transport = createHttpTransport({
  baseUrl: "http://192.168.4.1",
  requestTimeoutMs: 1500,
});

const client = new MonoblockEsp32GatewayClient({
  transport,
  pollIntervalMs: 700,
});

client.on("update", state => {
  console.log("modules:", state.modules);
  console.log("sensors:", state.sensors);
});

await client.connect();
await client.setLedState("red");
```

## Quick Start (VM Serial)

```js
import {
  MonoblockEsp32GatewayClient,
  createVmSerialTransport,
} from "@monoblock/esp32-gateway";

const transport = createVmSerialTransport({
  vm, // Scratch VM instance
  deviceId: "arduino",
  commandTimeoutMs: 2500,
  peripheralDataEvent: "PERIPHERAL_RECIVE_DATA",
});

const client = new MonoblockEsp32GatewayClient({ transport });
await client.connect();
```

## Windify Store Bridge

```js
import {
  createWindifyScannedDevicesBridge,
} from "@monoblock/esp32-gateway";

const bridge = createWindifyScannedDevicesBridge({
  client,
  setScannedDevices, // from windify-scanned-devices-store
});

bridge.start();
await bridge.refreshFromDevice();
```

## Public API

- `MonoblockEsp32GatewayClient`
  - `connect`, `disconnect`, `startPolling`, `stopPolling`, `pollOnce`
  - `getHealth`, `getModules`, `getSensors`, `scan`
  - `setLedState("red" | "green" | "blue" | "white" | "off" | "toggle" | "on")`
  - `readModule({id|addr,mux,ch}, len)`
  - `writeModule({id|addr,mux,ch}, bytesOrHex)`
- `createHttpTransport(...)`
- `createVmSerialTransport(...)`
- `toWindifyScannedDevices(...)`
- `createWindifyScannedDevicesBridge(...)`

## Notes

- The library is designed for dynamic module topologies. Unknown/new I2C modules still appear in `modules` output even if they are not predefined.
- For full generic read/write, use HTTP transport (`/api/module/read`, `/api/module/write`).
- VM serial transport currently supports command-level operations (`scan`, `modules`, `sensors`, `led`) and intentionally rejects generic raw read/write.
