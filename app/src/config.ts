import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),

  // Aqara API
  AQUARA_URL: z.string().url().default("https://aiot-rpc-usa.aqara.com"),
  AQARA_URL: z.string().url().optional(),
  APPID: z.string().min(8).default("444c476ef7135e53330f46e7"),
  TOKEN: z.string().min(16).optional().or(z.literal("")),
  USER_ID: z.string().optional(),
  PHONE_ID: z.string().optional(),
  AQARA_USER: z.string().optional(),
  AQARA_PASS: z.string().optional(),

  // MQTT
  MQTT_URL: z.string().url().default("mqtt://localhost:1883"),
  MQTT_USER: z.string().default(""),
  MQTT_PASS: z.string().default(""),

  // General
  POLL_INTERVAL: z.coerce.number().min(1).default(1), // seconds
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;
export const env = envSchema.parse(process.env);
