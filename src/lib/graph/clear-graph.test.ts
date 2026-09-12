import { describe, expect, it } from "vitest";
import { clearGraphUpdate } from "@/lib/graph/jena";

describe("清空图数据的语句", () => {
  it("配了命名图就清那张图，没配就清默认图", () => {
    expect(clearGraphUpdate(null)).toBe("CLEAR SILENT DEFAULT");
    expect(clearGraphUpdate("urn:ontology")).toBe("CLEAR SILENT GRAPH <urn:ontology>");
  });
});
