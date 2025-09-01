import { EntityConfig } from "./types.js";

export const ENTITIES: EntityConfig[] = [
  {
    domain: "switch",
    name: "Lens Obstruction Detection",
    attr: "lens_hide_enable",
    command: true,
  },
  {
    domain: "switch",
    name: "AI Sound Detection",
    attr: "ai_sound_enable",
    command: true,
  },
  {
    domain: "switch",
    name: "Face Detection",
    attr: "face_detect_enable",
    command: true,
  },
  {
    domain: "switch",
    name: "Human Detection",
    attr: "human_detect_enable",
    command: true,
  },
  {
    domain: "switch",
    name: "Pets Detection",
    attr: "pets_detect_enable",
    command: true,
  },
  {
    domain: "switch",
    name: "Vehicle Detection",
    attr: "vehicle_detect_enable",
    command: true,
  },
  {
    domain: "switch",
    name: "Package Detection",
    attr: "package_detect_enable",
    command: true,
  },
  { domain: "switch", name: "Lingerer Detection", attr: "pir_enable", command: true },
  {
    domain: "number",
    name: "System Volume",
    attr: "system_volume",
    command: true,
    unit: "%",
  },
  {
    domain: "number",
    name: "Alarm Volume",
    attr: "alarm_bell_volume",
    command: true,
    unit: "%",
  },
  {
    domain: "number",
    name: "Alarm Tone",
    attr: "alarm_bell_index",
    command: true,
  },
  {
    domain: "number",
    name: "Report Interval",
    attr: "report_status_sec",
    command: true,
    unit: "s",
  },
  {
    domain: "sensor",
    name: "WiFi RSSI",
    attr: "device_wifi_rssi",
    unit: "dBm",
  },
  { domain: "sensor", name: "WiFi Level", attr: "wifi_level" },
  { domain: "sensor", name: "SD Card", attr: "sdcard_status" },
  { domain: "sensor", name: "Alarm Status", attr: "alarm_status" },

  { domain: "sensor", name: "P2P Stream", attr: "P2P_capture_status" },
];
