import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),

  // Aqara API
  AQUARA_URL: z.string().url().default("https://aiot-rpc-usa.aqara.com"),
  APPID: z.string().min(8),
  TOKEN: z.string().min(16),
  SUBJECT_ID: z.string().min(10),

  // MQTT
  MQTT_URL: z.string().url().default("mqtt://localhost:1883"),
  MQTT_USER: z.string().default(""),
  MQTT_PASS: z.string().default(""),

  // General
  POLL_INTERVAL: z.coerce.number().min(1).default(1), // секунд
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;
export const env = envSchema.parse(process.env);
