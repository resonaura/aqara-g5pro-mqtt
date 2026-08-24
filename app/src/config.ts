import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),

  // Aqara API
  AQUARA_URL: z.string().url().default("https://aiot-rpc-usa.aqara.com"),
  APPID: z.string().min(8).default("444c476ef7135e53330f46e7"),
  TOKEN: z.string().min(16).optional().or(z.literal("")),
  AQARA_USER: z.string().optional(),
  AQARA_PASS: z.string().optional(),

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
