import {
  MonoblockEsp32GatewayClient,
  createDefaultModuleClassifier,
  toWindifyScannedDevices,
} from "../src/index.js";

class StubTransport {
  async connect() {}
  async disconnect() {}
  async request(op) {
    if (op.type === "health") return { ok: true, devices: { button: true, rgb2: true } };
    if (op.type === "modules") {
      return {
        ok: true,
        count: 2,
        modules: [
          { id: "button", type: "button", addr: "0x43", addr_dec: 67, mux: "0x70", channel: 3 },
          { id: "rgb42", type: "rgb", addr: "0x42", addr_dec: 66, mux: "0x70", channel: 1 },
        ],
      };
    }
    if (op.type === "sensors") return { ok: true, button_ok: true, button_pressed: false, adc_ok: false, adc_value: 0 };
    if (op.type === "scan") return this.request({ type: "modules" });
    if (op.type === "led") return { ok: true, active_state: op.state };
    throw new Error(`Unsupported op in stub: ${op.type}`);
  }
}

async function main() {
  const client = new MonoblockEsp32GatewayClient({ transport: new StubTransport(), pollIntervalMs: 10000 });
  await client.connect();
  await client.setLedState("blue");

  const classifier = createDefaultModuleClassifier();
  const mapped = toWindifyScannedDevices(client.getState().modules, { classifier });
  if (!Array.isArray(mapped) || mapped.length !== 2) {
    throw new Error("Smoke check failed: unexpected mapped devices");
  }
  client.stopPolling();
  await client.disconnect();
  console.log("smoke:ok");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
