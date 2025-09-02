import { writeFile } from "node:fs/promises";
import { ZodTypeAny, ZodDefault, ZodOptional, ZodEnum, ZodRawShape } from "zod";
import { envSchema } from "./config.js";

type EnumValues = readonly [string, ...string[]];

type UnwrappedTypeInfo = {
  inner: ZodTypeAny;
  optional: boolean;
  defaultValue?: string;
  enumValues?: EnumValues;
};

function isZodDefault(schema: ZodTypeAny): schema is ZodDefault<ZodTypeAny> {
  return schema instanceof ZodDefault;
}

function isZodOptional(schema: ZodTypeAny): schema is ZodOptional<ZodTypeAny> {
  return schema instanceof ZodOptional;
}

function isZodEnum(schema: ZodTypeAny): schema is ZodEnum<any> {
  return schema instanceof ZodEnum;
}

function unwrapType(schema: ZodTypeAny): UnwrappedTypeInfo {
  let current = schema;
  let optional = false;
  let defaultValue: string | undefined;
  let enumValues: EnumValues | undefined;

  if (isZodDefault(current)) {
    const def = current._def;
    if (typeof def.defaultValue === "function") {
      const rawDefault = (def.defaultValue as () => unknown)();
      defaultValue =
        rawDefault !== undefined ? String(rawDefault as any) : undefined;
    }
    if ("innerType" in def && def.innerType) {
      current = def.innerType;
    }
  }

  if (isZodOptional(current)) {
    optional = true;
    current = current.unwrap();
  }

  if (
    isZodEnum(current) &&
    Array.isArray(current.options) &&
    current.options.length > 0
  ) {
    enumValues = current.options as unknown as EnumValues;
  }

  return { inner: current, optional, defaultValue, enumValues };
}

export async function generateEnvExample(path = ".env.example") {
  const shape = envSchema.shape as ZodRawShape;

  const required: string[] = [];
  const optional: string[] = [];

  for (const [key, schema] of Object.entries(shape)) {
    const {
      optional: isOptional,
      defaultValue,
      enumValues,
    } = unwrapType(schema);

    const lines: string[] = [];

    if (enumValues) {
      lines.push(`# 🔘 one of: ${enumValues.join(", ")}`);
    }

    lines.push(`${key}=${defaultValue ?? "xxxxx"}`);

    const target = isOptional ? optional : required;
    target.push(lines.join("\n"));
  }

  const sections: string[] = [];

  if (required.length > 0) {
    sections.push("## 📌 Required environment variables", ...required, "");
  }

  if (optional.length > 0) {
    sections.push("## 💡 Optional environment variables", ...optional, "");
  }

  const output = sections.join("\n");

  await writeFile(path, output);
  console.log(`Generated ${path}`);
}

export function normalizeValue(domain: string, attr: string, value: any): any {
  if (domain === "switch" || domain === "binary_sensor") {
    return value === "1" ? "ON" : "OFF";
  }

  if (attr === "device_battery_power") {
    if (!value || value === "null" || value === "-1") return "unavailable";
  }

  if (attr === "work_mode") {
    return { "0": "Day", "1": "Night", "2": "Auto" }[value] ?? value;
  }

  if (domain === "number") return Number(value);

  return value;
}
