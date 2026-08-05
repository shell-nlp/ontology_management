export type DataType = "TEXT" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "DATE" | "DATETIME" | "TEXT_ARRAY" | "JSON";

export type PropertyDefinition = {
  name: string;
  dataType: DataType;
  required: boolean;
};

function coerceTyped(dataType: DataType, value: unknown): unknown {
  if (dataType === "TEXT") return String(value);
  if (dataType === "INTEGER") {
    const number = Number(value);
    if (!Number.isInteger(number)) throw new Error("该属性需要整数。");
    return number;
  }
  if (dataType === "DECIMAL") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("该属性需要小数。");
    return number;
  }
  if (dataType === "BOOLEAN") {
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    throw new Error("该属性需要布尔值。");
  }
  if (dataType === "DATE" || dataType === "DATETIME") return String(value);
  if (dataType === "TEXT_ARRAY") {
    if (Array.isArray(value)) return value.map((item) => String(item));
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) throw new Error("该属性需要数组。");
    return parsed.map((item) => String(item));
  }
  if (dataType === "JSON") {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    return JSON.parse(String(value));
  }
  return value;
}

function coerceRaw(value: unknown): unknown {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value === null) return null;
  const text = String(value).trim();
  if (text === "") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  if (/^[[{].*[}\]]$/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export function parsePropertyValues(
  definitions: PropertyDefinition[],
  raw: Record<string, unknown>,
  options: { allowArbitrary?: boolean } = {},
) {
  const allowed = new Set(definitions.map((property) => property.name));
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || value === null || value === "") continue;
    if (allowed.has(name)) {
      const definition = definitions.find((property) => property.name === name);
      if (definition) values[name] = coerceTyped(definition.dataType, value);
    } else if (options.allowArbitrary) {
      values[name] = coerceRaw(value);
    } else {
      throw new Error(`属性 ${name} 未在已发布类型中定义。`);
    }
  }
  for (const definition of definitions) {
    if (definition.required && !(definition.name in values)) throw new Error(`缺少必填属性：${definition.name}。`);
  }
  return values;
}
