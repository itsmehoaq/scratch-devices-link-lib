import { TransportError, UnsupportedOperationError } from "../core/errors.js";

const TEXT_DECODER = new TextDecoder();

export class VmSerialGatewayTransport {
  constructor(options = {}) {
    this.vm = options.vm;
    this.deviceId = options.deviceId;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2000;
    this.settleMs = options.settleMs ?? 180;
    this.lineEnding = options.lineEnding ?? "\n";
    this.logger = options.logger || null;
    this.peripheralDataEvent = options.peripheralDataEvent || "PERIPHERAL_RECIVE_DATA";

    this.connected = false;
    this._buffer = "";
    this._currentWait = null;
    this._chain = Promise.resolve();
    this._onVmData = this._onVmData.bind(this);
  }

  async connect() {
    if (!this.vm || !this.deviceId) {
      throw new TransportError("VmSerialGatewayTransport requires vm and deviceId", {
        code: "invalid_transport_config",
      });
    }
    if (typeof this.vm.addListener !== "function" || typeof this.vm.writeToPeripheral !== "function") {
      throw new TransportError("vm object does not provide required methods", {
        code: "invalid_vm_contract",
      });
    }
    if (!this.connected) {
      this.vm.addListener(this.peripheralDataEvent, this._onVmData);
      this.connected = true;
    }
    return true;
  }

  async disconnect() {
    if (this.connected && this.vm && typeof this.vm.removeListener === "function") {
      this.vm.removeListener(this.peripheralDataEvent, this._onVmData);
    }
    this.connected = false;
    return true;
  }

  isConnected() {
    if (!this.connected) return false;
    if (typeof this.vm.getPeripheralIsConnected === "function") {
      return !!this.vm.getPeripheralIsConnected(this.deviceId);
    }
    return true;
  }

  async request(op) {
    switch (op.type) {
      case "scan":
        return this._enqueue(() => this._scan());
      case "modules":
        return this._enqueue(() => this._modules());
      case "sensors":
        return this._enqueue(() => this._sensors());
      case "health":
        return this._enqueue(() => this._health());
      case "led":
        return this._enqueue(() => this._led(op.state));
      case "moduleRead":
      case "moduleWrite":
        throw new UnsupportedOperationError(
          `${op.type} is not supported on VmSerial transport (use HTTP transport for generic read/write)`
        );
      default:
        throw new UnsupportedOperationError(`Unsupported operation: ${op.type}`);
    }
  }

  _enqueue(work) {
    this._chain = this._chain.then(work, work);
    return this._chain;
  }

  async _scan() {
    const lines = await this._runCommand("scan", {
      doneWhen: line => line.trim().toLowerCase() === "scan:done",
      timeoutMs: this.commandTimeoutMs + 2500,
    });
    return this._parseScan(lines);
  }

  async _modules() {
    const lines = await this._runCommand("modules", {
      timeoutMs: this.commandTimeoutMs,
      settleMs: this.settleMs,
      minLines: 1,
      doneWhen: line => line.trim().toLowerCase() === "modules:done",
      settleWhen: lines => lines.some(line => /^modules:\s*count=/i.test(line)),
    });
    return this._parseModules(lines);
  }

  async _sensors() {
    const lines = await this._runCommand("sensors", {
      timeoutMs: this.commandTimeoutMs,
      settleMs: this.settleMs,
      doneWhen: line => /^sensors:\s*/i.test(line),
      settleWhen: lines => lines.some(line => /^sensors:\s*/i.test(line)),
    });
    return this._parseSensors(lines);
  }

  async _health() {
    const [modules, sensors] = await Promise.all([this._modules(), this._sensors().catch(() => null)]);
    const devices = {};
    for (const mod of modules.modules || []) {
      devices[mod.type] = true;
      if (mod.id === "led45") devices.led = true;
      if (mod.id === "rgb42") devices.rgb2 = true;
    }
    return {
      ok: true,
      transport: "vm_serial",
      module_count: modules.count ?? (modules.modules || []).length,
      devices,
      sensors: sensors || null,
    };
  }

  async _led(state) {
    const safeState = String(state || "toggle").toLowerCase();
    const lines = await this._runCommand(`led ${safeState}`, {
      timeoutMs: this.commandTimeoutMs,
      settleMs: this.settleMs,
      doneWhen: line => /^led:\s*/i.test(line),
      settleWhen: lines => lines.some(line => /^led:\s*/i.test(line)),
    });
    const ledLine = lines.find(line => /^led:\s*/i.test(line)) || "";
    return {
      ok: /ok=true/i.test(ledLine),
      state: safeState,
      raw: ledLine,
    };
  }

  _runCommand(command, options = {}) {
    if (!this.isConnected()) {
      throw new TransportError("Peripheral is not connected", {
        code: "not_connected",
      });
    }
    if (this._currentWait) {
      throw new TransportError("Another command is currently running", {
        code: "command_busy",
      });
    }

    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const settleMs = options.settleMs ?? this.settleMs;
    const doneWhen = options.doneWhen || null;
    const settleWhen = options.settleWhen || null;
    const minLines = options.minLines ?? 0;

    return new Promise((resolve, reject) => {
      const lines = [];
      let timeoutId = null;
      let settleId = null;

      const finish = result => {
        cleanup();
        resolve(result);
      };

      const fail = error => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (settleId) clearTimeout(settleId);
        if (this._currentWait && this._currentWait.pushLine === pushLine) {
          this._currentWait = null;
        }
      };

      const trySettle = () => {
        if (doneWhen) return;
        if (lines.length < minLines) return;
        if (settleWhen && !settleWhen(lines)) return;
        finish(lines.slice());
      };

      const pushLine = line => {
        const cleaned = String(line).replace(/\r$/, "");
        lines.push(cleaned);
        if (doneWhen && doneWhen(cleaned, lines)) {
          finish(lines.slice());
          return;
        }
        if (settleId) clearTimeout(settleId);
        settleId = setTimeout(trySettle, settleMs);
      };

      this._currentWait = { pushLine };
      timeoutId = setTimeout(() => {
        fail(
          new TransportError(`Command timeout: ${command}`, {
            code: "command_timeout",
            details: lines.slice(),
          })
        );
      }, timeoutMs);

      try {
        this.vm.writeToPeripheral(this.deviceId, `${command}${this.lineEnding}`);
      } catch (error) {
        fail(
          new TransportError(`Failed to write command: ${command}`, {
            code: "write_failed",
            cause: error,
          })
        );
      }
    });
  }

  _onVmData(data) {
    let chunk = "";
    if (typeof data === "string") {
      chunk = data;
    } else if (data instanceof Uint8Array) {
      chunk = TEXT_DECODER.decode(data, { stream: true });
    } else if (data && typeof data.length === "number") {
      chunk = TEXT_DECODER.decode(new Uint8Array(data), { stream: true });
    } else {
      chunk = String(data ?? "");
    }

    if (!chunk) return;
    this._buffer += chunk;
    const segments = this._buffer.split("\n");
    this._buffer = segments.pop() ?? "";
    for (const line of segments) {
      this._dispatchLine(line);
    }
  }

  _dispatchLine(line) {
    const cleaned = String(line).replace(/\r$/, "");
    if (this.logger && typeof this.logger.debug === "function") {
      this.logger.debug(`[VmSerialGatewayTransport] ${cleaned}`);
    }
    if (this._currentWait) {
      this._currentWait.pushLine(cleaned);
    }
  }

  _parseModules(lines) {
    const list = [];
    let count = 0;
    for (const line of lines) {
      const countMatch = line.match(/^modules:\s*count=(\d+)/i);
      if (countMatch) {
        count = Number.parseInt(countMatch[1], 10) || 0;
        continue;
      }
      const row = line.match(/^\s*\[(\d+)\]\s+id=([^\s]+)\s+type=([^\s]+)\s+addr=0x([0-9a-fA-F]{2})\s+mux=([^\s]+)\s+ch=(\d+)\s+probe=([^\s]+)/);
      if (!row) continue;
      list.push({
        index: Number.parseInt(row[1], 10),
        id: row[2],
        type: row[3],
        addr: `0x${row[4].toLowerCase()}`,
        addr_dec: Number.parseInt(row[4], 16),
        mux: row[5],
        channel: Number.parseInt(row[6], 10),
        probe: row[7],
      });
    }
    return {
      ok: true,
      count: count || list.length,
      modules: list,
      transport: "vm_serial",
    };
  }

  _parseSensors(lines) {
    const sensorLine = [...lines].reverse().find(line => /^sensors:\s*/i.test(line));
    if (!sensorLine) {
      throw new TransportError("Missing sensors output", {
        code: "invalid_response",
        details: lines,
      });
    }
    const m = sensorLine.match(/btn_ok=(true|false)\s+btn=(true|false)\s+adc_ok=(true|false)\s+adc=(\d+)/i);
    if (!m) {
      return {
        ok: false,
        raw: sensorLine,
      };
    }
    return {
      ok: m[1] === "true" || m[3] === "true",
      button_ok: m[1] === "true",
      button_pressed: m[2] === "true",
      adc_ok: m[3] === "true",
      adc_value: Number.parseInt(m[4], 10) || 0,
      raw: sensorLine,
    };
  }

  _parseScan(lines) {
    const modules = [];
    for (const line of lines) {
      const direct = line.match(/^Found\s+([A-Za-z0-9_]+)\s+0x([0-9a-fA-F]{2})\s+on\s+direct bus/i);
      if (direct) {
        const name = direct[1];
        const hex = direct[2];
        modules.push({
          id: `${name.toLowerCase()}_${hex.toLowerCase()}`,
          type: name.toLowerCase(),
          addr: `0x${hex.toLowerCase()}`,
          addr_dec: Number.parseInt(hex, 16),
          mux: "direct",
          channel: 0,
          probe: "scan",
        });
        continue;
      }
      const mux = line.match(/^Found\s+([A-Za-z0-9_]+)\s+0x([0-9a-fA-F]{2})\s+on\s+mux\s+0x([0-9a-fA-F]{2})\s+ch\s+(\d+)/i);
      if (mux) {
        const name = mux[1];
        const hex = mux[2];
        const muxAddr = mux[3];
        const ch = mux[4];
        modules.push({
          id: `${name.toLowerCase()}_${hex.toLowerCase()}_${muxAddr.toLowerCase()}_${ch}`,
          type: name.toLowerCase(),
          addr: `0x${hex.toLowerCase()}`,
          addr_dec: Number.parseInt(hex, 16),
          mux: `0x${muxAddr.toLowerCase()}`,
          channel: Number.parseInt(ch, 10),
          probe: "scan",
        });
      }
    }
    return {
      ok: true,
      count: modules.length,
      modules,
      raw: lines.slice(),
      transport: "vm_serial",
    };
  }
}

export const createVmSerialTransport = options => new VmSerialGatewayTransport(options);
