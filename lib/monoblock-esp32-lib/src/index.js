export { GatewayError, UnsupportedOperationError, TransportError } from "./core/errors.js";
export { SimpleEmitter } from "./core/simple-emitter.js";

export {
  MonoblockEsp32GatewayClient,
} from "./client/gateway-client.js";

export {
  HttpGatewayTransport,
  createHttpTransport,
} from "./transports/http-transport.js";

export {
  VmSerialGatewayTransport,
  createVmSerialTransport,
} from "./transports/vm-serial-transport.js";

export {
  DefaultModuleClassifier,
  createDefaultModuleClassifier,
  WindifyScannedDevicesBridge,
  createWindifyScannedDevicesBridge,
  toWindifyScannedDevices,
} from "./integrations/windify.js";
