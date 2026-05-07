export class GatewayError extends Error {
  code: string;
  cause?: unknown;
  details?: unknown;
}

export class UnsupportedOperationError extends GatewayError {}
export class TransportError extends GatewayError {}

export type UnsubscribeFn = () => void;

export class SimpleEmitter<TEvents extends Record<string, unknown> = Record<string, unknown>> {
  on<K extends keyof TEvents>(event: K, handler: (payload: TEvents[K]) => void): UnsubscribeFn;
  off<K extends keyof TEvents>(event: K, handler: (payload: TEvents[K]) => void): void;
  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void;
}

export type LedState = "red" | "green" | "blue" | "white" | "off" | "toggle" | "on";

export type ModuleInfo = {
  index?: number;
  id?: string;
  type?: string;
  addr?: string;
  addr_dec?: number;
  mux?: string;
  channel?: number;
  probe?: string;
  [key: string]: unknown;
};

export type HealthResponse = {
  ok?: boolean;
  module_count?: number;
  devices?: Record<string, boolean>;
  [key: string]: unknown;
};

export type ModulesResponse = {
  ok?: boolean;
  count?: number;
  modules: ModuleInfo[];
  [key: string]: unknown;
};

export type SensorsResponse = {
  ok?: boolean;
  button_ok?: boolean;
  button_pressed?: boolean;
  adc_ok?: boolean;
  adc_value?: number;
  [key: string]: unknown;
};

export type GatewayClientState = {
  connected: boolean;
  lastError: string | null;
  lastUpdatedAt: number;
  health: HealthResponse | null;
  sensors: SensorsResponse | null;
  modules: ModuleInfo[];
  devices: Record<string, boolean>;
  led: {
    activeState: string | null;
  };
};

export type GatewayTarget = {
  id?: string;
  addr?: string | number;
  mux?: string | number;
  ch?: string | number;
};

export interface GatewayTransport {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  isConnected?(): boolean;
  request(op: { type: string; [key: string]: unknown }): Promise<any>;
}

export type GatewayClientEvents = {
  connected: GatewayClientState;
  disconnected: GatewayClientState;
  update: GatewayClientState;
  error: string;
  modules: ModuleInfo[];
  devices: Record<string, boolean>;
  sensors: SensorsResponse | null;
  led: {
    activeState: string | null;
    response?: unknown;
  };
};

export class MonoblockEsp32GatewayClient extends SimpleEmitter<GatewayClientEvents> {
  constructor(options: {
    transport: GatewayTransport;
    pollIntervalMs?: number;
    maxConsecutiveFailures?: number;
  });

  transport: GatewayTransport;
  pollIntervalMs: number;
  maxConsecutiveFailures: number;

  getState(): GatewayClientState;
  connect(): Promise<GatewayClientState>;
  disconnect(): Promise<void>;
  startPolling(): void;
  stopPolling(): void;
  pollOnce(): Promise<GatewayClientState>;
  getHealth(): Promise<HealthResponse>;
  scan(): Promise<ModulesResponse>;
  getModules(): Promise<ModulesResponse>;
  getSensors(): Promise<SensorsResponse>;
  setLedState(state: LedState): Promise<any>;
  readModule(target?: GatewayTarget, len?: number): Promise<{
    bytes: number[];
    [key: string]: unknown;
  }>;
  writeModule(target?: GatewayTarget, bytes?: string | Uint8Array | number[]): Promise<any>;
}

export class HttpGatewayTransport implements GatewayTransport {
  constructor(options?: {
    baseUrl?: string;
    requestTimeoutMs?: number;
    fetchImpl?: typeof fetch;
  });
  baseUrl: string;
  requestTimeoutMs: number;
  connected: boolean;
  connect(): Promise<boolean>;
  disconnect(): Promise<boolean>;
  isConnected(): boolean;
  request(op: { type: string; [key: string]: unknown }): Promise<any>;
}

export function createHttpTransport(options?: ConstructorParameters<typeof HttpGatewayTransport>[0]): HttpGatewayTransport;

export class VmSerialGatewayTransport implements GatewayTransport {
  constructor(options: {
    vm: {
      addListener: (event: string, cb: (data: unknown) => void) => void;
      removeListener?: (event: string, cb: (data: unknown) => void) => void;
      writeToPeripheral: (deviceId: string, data: string) => void;
      getPeripheralIsConnected?: (deviceId: string) => boolean;
    };
    deviceId: string;
    commandTimeoutMs?: number;
    settleMs?: number;
    lineEnding?: string;
    peripheralDataEvent?: string;
    logger?: { debug?: (msg: string) => void };
  });
  connected: boolean;
  connect(): Promise<boolean>;
  disconnect(): Promise<boolean>;
  isConnected(): boolean;
  request(op: { type: string; [key: string]: unknown }): Promise<any>;
}

export function createVmSerialTransport(options: ConstructorParameters<typeof VmSerialGatewayTransport>[0]): VmSerialGatewayTransport;

export type WindifyScannedDevice = {
  found: boolean;
  commtype: string;
  device_name: string;
  port: number | string;
  bus: number;
  channel: number;
  id: string | null;
  addr: string | null;
  mux: string;
  raw: ModuleInfo;
  analog?: number;
};

export class DefaultModuleClassifier {
  constructor(options?: {
    signatures?: Array<{
      when: (module: ModuleInfo) => boolean;
      map: Record<string, unknown>;
    }>;
    muxBusMap?: Record<string, number>;
  });

  classify(module: ModuleInfo): ModuleInfo & {
    addr_dec: number | null;
    mux: string;
    channel: number;
    device_name: string;
    commtype: string;
  };
  muxToBus(mux: string): number;
}

export function createDefaultModuleClassifier(
  options?: ConstructorParameters<typeof DefaultModuleClassifier>[0]
): DefaultModuleClassifier;

export function toWindifyScannedDevices(
  modules?: ModuleInfo[],
  options?: {
    classifier?: DefaultModuleClassifier;
    portResolver?: (
      module: ModuleInfo,
      context: { indexInGroup: number; bus: number; channel: number }
    ) => number | string;
  }
): WindifyScannedDevice[];

export class WindifyScannedDevicesBridge {
  constructor(options: {
    client: MonoblockEsp32GatewayClient;
    setScannedDevices: (items: WindifyScannedDevice[]) => void;
    classifier?: DefaultModuleClassifier;
    portResolver?: (
      module: ModuleInfo,
      context: { indexInGroup: number; bus: number; channel: number }
    ) => number | string;
  });
  start(): void;
  stop(): void;
  refreshFromDevice(): Promise<ModuleInfo[]>;
}

export function createWindifyScannedDevicesBridge(
  options: ConstructorParameters<typeof WindifyScannedDevicesBridge>[0]
): WindifyScannedDevicesBridge;
