import { SimpleEmitter } from "../core/simple-emitter.js";
import { GatewayError } from "../core/errors.js";

const LED_STATES = new Set(["red", "green", "blue", "white", "off", "toggle", "on"]);

export class MonoblockEsp32GatewayClient extends SimpleEmitter {
  constructor(options = {}) {
    super();
    if (!options.transport) {
      throw new GatewayError("MonoblockEsp32GatewayClient requires a transport", {
        code: "missing_transport",
      });
    }
    this.transport = options.transport;
    this.pollIntervalMs = options.pollIntervalMs ?? 700;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;

    this._timer = null;
    this._pollInFlight = false;
    this._consecutiveFailures = 0;

    this._state = {
      connected: false,
      lastError: null,
      lastUpdatedAt: 0,
      health: null,
      sensors: null,
      modules: [],
      devices: {},
      led: {
        activeState: null,
      },
    };
  }

  getState() {
    return {
      ...this._state,
      modules: this._state.modules.map(m => ({ ...m })),
      devices: { ...this._state.devices },
      led: { ...this._state.led },
    };
  }

  async connect() {
    await this.transport.connect();
    await this.pollOnce();
    this.startPolling();
    return this.getState();
  }

  async disconnect() {
    this.stopPolling();
    await this.transport.disconnect();
    this._setConnected(false);
  }

  startPolling() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.pollOnce().catch(() => {
        // pollOnce already sets state and emits errors.
      });
    }, this.pollIntervalMs);
  }

  stopPolling() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  async pollOnce() {
    if (this._pollInFlight) return this.getState();
    this._pollInFlight = true;
    try {
      const [health, modules, sensors] = await Promise.all([
        this.getHealth().catch(() => null),
        this.getModules(),
        this.getSensors().catch(() => null),
      ]);

      this._consecutiveFailures = 0;
      this._setConnected(true);

      this._state.health = health;
      this._state.modules = Array.isArray(modules?.modules) ? modules.modules : [];
      this._state.sensors = sensors;
      this._state.lastError = null;
      this._state.lastUpdatedAt = Date.now();
      this._state.devices = this._deriveDevices(health, this._state.modules);

      this.emit("devices", { ...this._state.devices });
      this.emit("modules", this._state.modules.map(m => ({ ...m })));
      this.emit("sensors", sensors ? { ...sensors } : null);
      this.emit("update", this.getState());
      return this.getState();
    } catch (error) {
      this._consecutiveFailures += 1;
      this._state.lastError = String(error?.message || error || "poll failed");
      this.emit("error", this._state.lastError);
      if (this._consecutiveFailures >= this.maxConsecutiveFailures) {
        this._setConnected(false);
      }
      throw error;
    } finally {
      this._pollInFlight = false;
    }
  }

  async getHealth() {
    return this.transport.request({ type: "health" });
  }

  async scan() {
    const result = await this.transport.request({ type: "scan" });
    if (Array.isArray(result?.modules)) {
      this._state.modules = result.modules;
      this._state.devices = this._deriveDevices(this._state.health, result.modules);
      this._state.lastUpdatedAt = Date.now();
      this.emit("modules", this._state.modules.map(m => ({ ...m })));
      this.emit("devices", { ...this._state.devices });
      this.emit("update", this.getState());
    }
    return result;
  }

  async getModules() {
    return this.transport.request({ type: "modules" });
  }

  async getSensors() {
    return this.transport.request({ type: "sensors" });
  }

  async setLedState(state) {
    const safe = String(state || "").toLowerCase();
    if (!LED_STATES.has(safe)) {
      throw new GatewayError(`Invalid led state: ${state}`, {
        code: "invalid_led_state",
      });
    }
    const result = await this.transport.request({ type: "led", state: safe });
    if (typeof result?.active_state === "string") {
      this._state.led.activeState = result.active_state;
    } else if (typeof result?.state === "string") {
      this._state.led.activeState = result.state;
    }
    this.emit("led", { ...this._state.led, response: result });
    return result;
  }

  async readModule(target = {}, len = 1) {
    const parsedLen = Number.isInteger(len) ? len : 1;
    const response = await this.transport.request({
      type: "moduleRead",
      target,
      len: parsedLen,
    });
    return {
      ...response,
      bytes: this._hexToBytes(response?.hex || ""),
    };
  }

  async writeModule(target = {}, bytes = []) {
    const hexPayload = this._toHexPayload(bytes);
    return this.transport.request({
      type: "moduleWrite",
      target,
      hexPayload,
    });
  }

  _setConnected(next) {
    const prev = this._state.connected;
    this._state.connected = !!next;
    if (prev !== this._state.connected) {
      this.emit(this._state.connected ? "connected" : "disconnected", this.getState());
    }
  }

  _deriveDevices(health, modules) {
    if (health?.devices && typeof health.devices === "object") {
      return { ...health.devices };
    }
    const devices = {};
    for (const module of modules || []) {
      const type = String(module?.type || "").toLowerCase();
      if (!type) continue;
      devices[type] = true;
      const id = String(module?.id || "").toLowerCase();
      if (id === "led45") devices.led = true;
      if (id === "rgb42") devices.rgb2 = true;
      if (type === "rgb" || type === "rgb2") devices.rgb2 = true;
      if (Number(module?.addr_dec) === 0x42) devices.rgb2 = true;
    }
    return devices;
  }

  _toHexPayload(bytes) {
    if (typeof bytes === "string") {
      const text = bytes.trim();
      if (!text) {
        throw new GatewayError("Hex payload cannot be empty", {
          code: "invalid_payload",
        });
      }
      return text;
    }
    if (!(bytes instanceof Uint8Array) && !Array.isArray(bytes)) {
      throw new GatewayError("Payload must be a string, Uint8Array, or number[]", {
        code: "invalid_payload_type",
      });
    }
    const arr = Array.from(bytes);
    if (arr.length === 0) {
      throw new GatewayError("Payload cannot be empty", {
        code: "invalid_payload",
      });
    }
    return arr.map(v => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 255) {
        throw new GatewayError(`Invalid byte value: ${v}`, {
          code: "invalid_payload_byte",
        });
      }
      return n.toString(16).padStart(2, "0");
    }).join("");
  }

  _hexToBytes(hexText) {
    const normalized = String(hexText || "").trim();
    if (!normalized) return [];
    if (/^[0-9a-fA-F]+$/.test(normalized) && normalized.length % 2 === 0) {
      const out = [];
      for (let i = 0; i < normalized.length; i += 2) {
        out.push(Number.parseInt(normalized.slice(i, i + 2), 16));
      }
      return out;
    }
    return normalized
      .split(/\s+/)
      .map(part => Number.parseInt(part, 16))
      .filter(n => !Number.isNaN(n));
  }
}
