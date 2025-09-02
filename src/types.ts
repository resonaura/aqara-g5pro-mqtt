export interface AqaraAttribute {
  attr: string;
  value: any;
  timeStamp: number;
}

export interface AqaraResponse {
  result: AqaraAttribute[];
  code: number;
  message: string;
}

export interface EntityConfig {
  domain: "sensor" | "binary_sensor" | "switch" | "light" | "number" | "button";
  name: string;
  attr: string;
  icon: string;
  deviceClass?: string;
  unit?: string;
  command?: boolean; // если поддерживает запись
}

export interface AqaraPullDevicesResponse {
  result: AqaraPullDevicesResult;
  code: number;
  requestId: string;
  message: string;
  msgDetails: string;
}

export interface AqaraPullDevicesResult {
  devices: Device[];
  count: number;
}

export interface Device {
  deviceName: string;
  devicetype: number;
  positionName: string;
  originalName: string;
  categoryNames: string[];
  lowBatteryFlag: number;
  supportHomeKit: number;
  parentDeviceId: string;
  model: string;
  state: number;
  firmwareVersion?: string;
  usageType: number;
  real2: string;
  pwdState: number;
  real1: string;
  layout: number;
  positionId: string;
  createTime: string;
  did: string;
  type?: number;
}

export interface MQTTDevice {
  identifiers: string[];
  manufacturer: string;
  model: string;
  name: string;
  _simpleModel: string;
}
