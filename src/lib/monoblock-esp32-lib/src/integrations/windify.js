import { GatewayError } from "../core/errors.js";

const DEFAULT_MUX_BUS_MAP = {
  direct: 0,
  "0x00": 0,
  "0x70": 0,
  "0x74": 1,
};

const DEFAULT_SENSOR_SIGNATURES = [
  { when: module => module.id === "adc" || module.type === "adc", map: { device_name: "ADC", commtype: "adc" } },
  { when: module => module.id === "button" || module.type === "button", map: { device_name: "BUTTON", commtype: "i2c" } },
  { when: module => module.id === "rgb42" || module.addr_dec === 0x42, map: { device_name: "WS2812B", commtype: "i2c" } },
  { when: module => module.id === "led45" || module.addr_dec === 0x45, map: { device_name: "LED", commtype: "i2c" } },
  { when: module => module.id === "oled" || module.addr_dec === 0x3c, map: { device_name: "SSD1306", commtype: "i2c" } },
  { when: module => module.addr_dec === 0x76 || module.addr_dec === 0x77, map: { device_name: "BME680", commtype: "i2c" } },
  { when: module => module.addr_dec === 0x29, map: { device_name: "TCS3472", commtype: "i2c" } },
];

function normalizeAddrDec(module) {
  if (Number.isInteger(module?.addr_dec)) return module.addr_dec;
  const addr = String(module?.addr || "");
  if (/^0x[0-9a-fA-F]+$/.test(addr)) return Number.parseInt(addr, 16);
  if (/^\d+$/.test(addr)) return Number.parseInt(addr, 10);
  return null;
}

function normalizeMux(module) {
  const mux = module?.mux;
  if (mux === null || mux === undefined) return "direct";
  const text = String(mux).trim().toLowerCase();
  return text || "direct";
}

export class DefaultModuleClassifier {
  constructor(options = {}) {
    this.signatures = Array.isArray(options.signatures)
      ? [...DEFAULT_SENSOR_SIGNATURES, ...options.signatures]
      : [...DEFAULT_SENSOR_SIGNATURES];
    this.muxBusMap = { ...DEFAULT_MUX_BUS_MAP, ...(options.muxBusMap || {}) };
  }

  classify(module) {
    const normalized = {
      ...module,
      addr_dec: normalizeAddrDec(module),
      mux: normalizeMux(module),
      channel: Number.isInteger(module?.channel) ? module.channel : 0,
    };

    for (const signature of this.signatures) {
      if (!signature.when(normalized)) continue;
      return {
        ...normalized,
        ...signature.map,
      };
    }
    return {
      ...normalized,
      device_name: String(normalized.type || normalized.id || "UNKNOWN").toUpperCase(),
      commtype: "i2c",
    };
  }

  muxToBus(mux) {
    const key = String(mux || "direct").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(this.muxBusMap, key)) {
      return this.muxBusMap[key];
    }
    return 0;
  }
}

export const createDefaultModuleClassifier = options => new DefaultModuleClassifier(options);

export function toWindifyScannedDevices(modules = [], options = {}) {
  const classifier = options.classifier || createDefaultModuleClassifier();
  const groupedCounters = new Map();
  const result = [];

  for (const module of modules) {
    const classified = classifier.classify(module);
    const key = `${classified.device_name}::${classified.commtype}`;
    const nextIndex = groupedCounters.get(key) || 0;
    groupedCounters.set(key, nextIndex + 1);

    const bus = classifier.muxToBus(classified.mux);
    const channel = Number.isInteger(classified.channel) ? classified.channel : 0;
    const defaultPort = channel;
    const port = options.portResolver
      ? options.portResolver(classified, { indexInGroup: nextIndex, bus, channel })
      : defaultPort;

    const item = {
      found: true,
      commtype: classified.commtype,
      device_name: classified.device_name,
      port,
      bus,
      channel,
      id: classified.id || null,
      addr: classified.addr || null,
      mux: classified.mux || "direct",
      raw: classified,
    };

    // Preserve analog alias expected by some blocks (A/D style modules).
    if (classified.commtype === "A/D" || classified.commtype === "adc") {
      item.analog = typeof classified.analog === "number" ? classified.analog : Number(port);
    }

    result.push(item);
  }
  return result;
}

export class WindifyScannedDevicesBridge {
  constructor(options = {}) {
    this.client = options.client;
    this.setScannedDevices = options.setScannedDevices;
    this.classifier = options.classifier || createDefaultModuleClassifier();
    this.portResolver = options.portResolver || null;

    this._unsubs = [];
  }

  start() {
    if (!this.client) {
      throw new GatewayError("WindifyScannedDevicesBridge requires client", {
        code: "missing_client",
      });
    }
    if (typeof this.setScannedDevices !== "function") {
      throw new GatewayError("WindifyScannedDevicesBridge requires setScannedDevices function", {
        code: "missing_setter",
      });
    }
    this.stop();
    this._unsubs.push(this.client.on("modules", modules => this._push(modules || [])));
    this._unsubs.push(this.client.on("disconnected", () => this._push([])));
    this._push(this.client.getState().modules || []);
  }

  stop() {
    for (const unsub of this._unsubs) {
      try {
        unsub();
      } catch {
        // no-op
      }
    }
    this._unsubs = [];
  }

  async refreshFromDevice() {
    const payload = await this.client.scan();
    const modules = Array.isArray(payload?.modules) ? payload.modules : [];
    this._push(modules);
    return modules;
  }

  _push(modules) {
    const mapped = toWindifyScannedDevices(modules, {
      classifier: this.classifier,
      portResolver: this.portResolver,
    });
    this.setScannedDevices(mapped);
  }
}

export const createWindifyScannedDevicesBridge = options => new WindifyScannedDevicesBridge(options);
