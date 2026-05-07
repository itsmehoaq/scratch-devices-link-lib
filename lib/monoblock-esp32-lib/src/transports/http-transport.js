import { TransportError, UnsupportedOperationError } from "../core/errors.js";

const hasFetch = typeof fetch === "function";

export class HttpGatewayTransport {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || "http://192.168.4.1").replace(/\/+$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1500;
    this.fetchImpl = options.fetchImpl || (hasFetch ? fetch.bind(globalThis) : null);
    this.connected = false;
  }

  async connect() {
    if (!this.fetchImpl) {
      throw new TransportError("No fetch implementation available", {
        code: "missing_fetch",
      });
    }
    this.connected = true;
    return true;
  }

  async disconnect() {
    this.connected = false;
    return true;
  }

  isConnected() {
    return this.connected;
  }

  async request(op) {
    if (!this.connected) {
      throw new TransportError("Transport is not connected", {
        code: "not_connected",
      });
    }
    switch (op.type) {
      case "health":
        return this._requestJson("GET", "/api/health");
      case "modules":
        return this._requestJson("GET", "/api/modules");
      case "sensors":
        return this._requestJson("GET", "/api/sensors");
      case "led":
        return this._requestJson("POST", `/api/led?state=${encodeURIComponent(op.state)}`);
      case "moduleRead":
        return this._requestJson("GET", `/api/module/read?${this._routeQuery(op.target)}&len=${encodeURIComponent(op.len ?? 1)}`);
      case "moduleWrite":
        return this._requestJson("POST", `/api/module/write?${this._routeQuery(op.target)}&hex=${encodeURIComponent(op.hexPayload)}`);
      case "scan":
        // Current firmware does not expose an explicit /api/scan endpoint.
        // Modules endpoint reflects current topology + auto-rescan behavior.
        return this._requestJson("GET", "/api/modules");
      default:
        throw new UnsupportedOperationError(`Unsupported operation: ${op.type}`);
    }
  }

  _routeQuery(target = {}) {
    if (target.id) {
      return `id=${encodeURIComponent(String(target.id))}`;
    }
    if (target.addr === undefined || target.addr === null) {
      throw new TransportError("Target requires id or addr", {
        code: "invalid_target",
      });
    }
    const params = new URLSearchParams();
    params.set("addr", String(target.addr));
    if (target.mux !== undefined && target.mux !== null) params.set("mux", String(target.mux));
    if (target.ch !== undefined && target.ch !== null) params.set("ch", String(target.ch));
    return params.toString();
  }

  async _requestJson(method, path) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      const text = await response.text();
      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch (error) {
        throw new TransportError(`Invalid JSON from ${path}`, {
          code: "invalid_json",
          cause: error,
          details: text,
        });
      }
      if (!response.ok) {
        throw new TransportError(`HTTP ${response.status} ${path}`, {
          code: "http_error",
          details: json,
        });
      }
      return json;
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError(`HTTP request failed: ${method} ${path}`, {
        code: "request_failed",
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export const createHttpTransport = options => new HttpGatewayTransport(options);
