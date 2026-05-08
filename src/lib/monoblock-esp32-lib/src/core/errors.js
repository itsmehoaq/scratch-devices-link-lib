export class GatewayError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "GatewayError";
    this.code = options.code || "gateway_error";
    this.cause = options.cause;
    this.details = options.details || null;
  }
}

export class UnsupportedOperationError extends GatewayError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || "unsupported_operation" });
    this.name = "UnsupportedOperationError";
  }
}

export class TransportError extends GatewayError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || "transport_error" });
    this.name = "TransportError";
  }
}
