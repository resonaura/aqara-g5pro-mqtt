export interface AqaraAttribute {
  attr: string;
  value: string | number | object;
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
  deviceClass?: string;
  unit?: string;
  command?: boolean; // если поддерживает запись
}
