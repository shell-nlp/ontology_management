import { describe, expect, it } from "vitest";
import { cypherPropertyText, inferDataTypeFromNeo4jValueType, isAutoUniqueCandidate } from "@/lib/instances";

describe("isAutoUniqueCandidate", () => {
  it("does not infer a unique constraint when any value may be too large for the index", () => {
    expect(isAutoUniqueCandidate({ cnt: 841, distinctCount: 841, maxCharacterLength: 4_977 })).toBe(false);
  });

  it("only infers uniqueness for distinct values within the conservative UTF-8 bound", () => {
    expect(isAutoUniqueCandidate({ cnt: 2, distinctCount: 2, maxCharacterLength: 250 })).toBe(true);
    expect(isAutoUniqueCandidate({ cnt: 2, distinctCount: 1, maxCharacterLength: 10 })).toBe(false);
  });

  it("serializes list properties item by item before measuring their length", () => {
    expect(cypherPropertyText("value")).toBe("CASE WHEN valueType(value) STARTS WITH 'LIST<' THEN reduce(text = '', item IN value | text + CASE WHEN item IS NULL THEN '' ELSE toString(item) END + ' ') WHEN value IS NULL THEN '' ELSE toString(value) END");
  });

  it("maps Neo4j value types without returning a property sample", () => {
    expect(inferDataTypeFromNeo4jValueType("STRING NOT NULL")).toBe("TEXT");
    expect(inferDataTypeFromNeo4jValueType("LIST<STRING NOT NULL> NOT NULL")).toBe("TEXT_ARRAY");
    expect(inferDataTypeFromNeo4jValueType("ZONED DATETIME NOT NULL")).toBe("DATETIME");
  });
});
