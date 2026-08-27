import { EntityConfig } from "./types.js";

export const ENTITIES: EntityConfig[] = [
  {
    domain: "switch",
    name: "Lens Obstruction Detection",
    attr: "lens_hide_enable",
    command: true,
    icon: "mdi:camera-off",
  },
  {
    domain: "switch",
    name: "AI Sound Detection",
    attr: "ai_sound_enable",
    icon: "mdi:microphone",
    command: true,
  },
  {
    domain: "switch",
    name: "Face Detection",
    attr: "face_detect_enable",
    icon: "mdi:face-recognition",
    command: true,
  },
  {
    domain: "switch",
    name: "Human Detection",
    attr: "human_detect_enable",
    icon: "mdi:walk",
    command: true,
  },
  {
    domain: "switch",
    name: "Pets Detection",
    attr: "pets_detect_enable",
    icon: "mdi:paw",
    command: true,
  },
  {
    domain: "switch",
    name: "Vehicle Detection",
    attr: "vehicle_detect_enable",
    icon: "mdi:car",
    command: true,
  },
  {
    domain: "switch",
    name: "Package Detection",
    attr: "package_detect_enable",
    icon: "mdi:package-variant",
    command: true,
  },
  {
    domain: "switch",
    name: "Lingerer Detection",
    attr: "pir_enable",
    icon: "mdi:motion-sensor",
    command: true,
  },
  {
    domain: "number",
    name: "System Volume",
    attr: "system_volume",
    icon: "mdi:volume-high",
    command: true,
    unit: "%",
  },
  {
    domain: "number",
    name: "Alarm Volume",
    attr: "alarm_bell_volume",
    icon: "mdi:alarm-bell",
    command: true,
    unit: "%",
  },
  {
    domain: "number",
    name: "Alarm Tone",
    attr: "alarm_bell_index",
    icon: "mdi:bell",
    command: true,
  },
  {
    domain: "sensor",
    name: "WiFi RSSI",
    attr: "device_wifi_rssi",
    icon: "mdi:wifi",
    unit: "dBm",
  },
  {
    domain: "sensor",
    name: "WiFi Level",
    attr: "wifi_level",
    icon: "mdi:wifi",
  },
  {
    domain: "sensor",
    name: "SD Card",
    attr: "sdcard_status",
    icon: "mdi:sd-card",
  },
  {
    domain: "sensor",
    name: "Alarm Status",
    attr: "alarm_status",
    icon: "mdi:alarm",
  },

  {
    domain: "sensor",
    name: "P2P Stream",
    attr: "P2P_capture_status",
    icon: "mdi:camera",
  },
  {
    domain: "switch",
    name: "Human Tracking",
    attr: "humans_track",
    icon: "mdi:target-account",
    command: true,
  },
  {
    domain: "switch",
    name: "PTZ Cruise",
    attr: "ptz_cruise",
    icon: "mdi:radar",
    command: true,
  },
];

export function isEntitySupported(model: string, attr: string): boolean {
  const m = (model || "").toLowerCase();
  const isE1 = m.includes("acn") || m.includes("e1");
  const isG5Pro = m.includes("agl004") || m.includes("g5");

  // PTZ-only attributes
  if (attr === "ptz_cruise" || attr === "humans_track" || attr.startsWith("ptz_")) {
    return isE1 || m.includes("g3") || m.includes("ptz");
  }

  // Outdoor G5 Pro / Advanced AI & PIR specific attributes
  if (attr === "pir_enable" || attr === "lens_hide_enable" || attr === "white_light_enable" || attr === "white_light_level") {
    return isG5Pro;
  }
  if (attr === "face_detect_enable" || attr === "pets_detect_enable" || attr === "vehicle_detect_enable" || attr === "package_detect_enable") {
    return isG5Pro || m.includes("g3");
  }

  // Common attributes supported across all Aqara cameras (system_volume, alarm_bell_volume, etc.)
  return true;
}
