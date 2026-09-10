import type { DataType } from "@/lib/instance-property-editor";

/**
 * 与后端无关的取值与类型推断工具。
 * 放在共享模块里，避免 Jena 适配器为了一个纯函数去依赖 neo4j-driver。
 */

const MAX_AUTO_UNIQUE_BYTES = 1000;
const MAX_UTF8_BYTES_PER_CHARACTER = 4;

/** 自动推断唯一约束时使用的保守字符长度上限（Neo4j 索引键为 UTF-8 字节）。 */
export const MAX_AUTO_UNIQUE_CHARACTERS = Math.floor(MAX_AUTO_UNIQUE_BYTES / MAX_UTF8_BYTES_PER_CHARACTER);

export function isAutoUniqueCandidate(row: { cnt: number; distinctCount: number; maxCharacterLength: number }) {
  return row.cnt > 1 && row.distinctCount === row.cnt && row.maxCharacterLength <= MAX_AUTO_UNIQUE_CHARACTERS;
}

const XSD = "http://www.w3.org/2001/XMLSchema#";

const INTEGER_TYPES = ["integer", "int", "long", "short", "byte", "nonNegativeInteger", "nonPositiveInteger", "negativeInteger", "positiveInteger", "unsignedLong", "unsignedInt", "unsignedShort", "unsignedByte"];
const DECIMAL_TYPES = ["decimal", "double", "float"];

const DATATYPE_LOCAL_NAMES: Record<DataType, string> = {
  TEXT: "string",
  INTEGER: "integer",
  DECIMAL: "decimal",
  BOOLEAN: "boolean",
  DATE: "date",
  DATETIME: "dateTime",
  TEXT_ARRAY: "string",
  JSON: "string",
};

/** 应用写入 RDF 时用来标记 JSON 属性的自定义数据类型。 */
export const BKN_JSON_DATATYPE = "urn:bkn:json";

export function dataTypeFromSparqlDatatype(datatype: string | null | undefined): DataType {
  if (!datatype) return "TEXT";
  if (datatype === BKN_JSON_DATATYPE) return "JSON";
  const local = datatype.split("#").pop()?.split("/").pop() ?? "";
  if (INTEGER_TYPES.includes(local)) return "INTEGER";
  if (DECIMAL_TYPES.includes(local)) return "DECIMAL";
  if (local === "boolean") return "BOOLEAN";
  if (local === "date") return "DATE";
  if (local === "dateTime" || local === "dateTimeStamp") return "DATETIME";
  return "TEXT";
}

export function sparqlDatatypeFor(dataType: DataType) {
  if (dataType === "JSON") return BKN_JSON_DATATYPE;
  return `${XSD}${DATATYPE_LOCAL_NAMES[dataType] ?? "string"}`;
}

/** SPARQL JSON 结果中的 literal -> JS 值。 */
export function valueFromSparqlLiteral(value: string, datatype?: string | null): unknown {
  const dataType = dataTypeFromSparqlDatatype(datatype);
  if (dataType === "INTEGER") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (dataType === "DECIMAL") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (dataType === "BOOLEAN") return value === "true" || value === "1";
  if (dataType === "JSON") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function escapeSparqlString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

/** JS 值 -> SPARQL 字面量。arrays 由调用方展开成多条语句。 */
export function sparqlLiteral(value: unknown, dataType: DataType): string | null {
  if (value === null || value === undefined) return null;
  if (dataType === "JSON" || typeof value === "object") {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `"${escapeSparqlString(text)}"^^<${BKN_JSON_DATATYPE}>`;
  }
  if (dataType === "BOOLEAN" || typeof value === "boolean") return `${value === true || value === "true" ? "true" : "false"}`;
  if (dataType === "INTEGER" && typeof value === "number") return `${Math.trunc(value)}`;
  if (dataType === "DECIMAL" && typeof value === "number") return `${value}`;
  if (typeof value === "number") return `${value}`;
  return `"${escapeSparqlString(String(value))}"^^<${sparqlDatatypeFor(dataType)}>`;
}

export function escapeSparqlStringLiteral(value: string) {
  return escapeSparqlString(value);
}
