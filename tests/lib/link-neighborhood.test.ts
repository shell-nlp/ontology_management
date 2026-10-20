import { expect, it, vi } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";

const mocks = vi.hoisted(() => ({
  selectRowsBy: vi.fn(),
}));

vi.mock("@/lib/instance/object-service/data-source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instance/object-service/data-source")>();
  return {
    ...actual,
    connectorFor: vi.fn(async () => ({ connector: { selectRows: mocks.selectRowsBy, countRows: vi.fn(async () => 1) }, label: "测试库" })),
    selectRowsBy: mocks.selectRowsBy,
  };
});

import { queryLinkNeighborhood } from "@/lib/instance/object-service/links";

const ENTITY_ID = "11111111-1111-4111-8111-111111111111";
const RELATION_ID = "22222222-2222-4222-8222-222222222222";
const DS_ID = "a1000000-0000-4000-8000-000000000001";
const definition = ontologyDefinitionSchema.parse({
  entityTypes: [{
    id: ENTITY_ID,
    name: "客户",
    properties: [{ name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" }],
    sources: [{ id: "primary", dataSourceId: DS_ID, schema: "S", view: "CUSTOMER", primaryKey: ["CUST_ID"] }],
  }],
  relationshipTypes: [{
    id: RELATION_ID,
    name: "客户推荐客户",
    sourceEntityTypeId: ENTITY_ID,
    targetEntityTypeId: ENTITY_ID,
    sourceKeyMappings: [{ linkProperty: "SRC_ID", entityProperty: "客户编号" }],
    targetKeyMappings: [{ linkProperty: "DST_ID", entityProperty: "客户编号" }],
    linkSource: { mode: "JOIN_TABLE", dataSourceId: DS_ID, schema: "S", view: "CUSTOMER_LINK" },
  }],
});

it("有界邻域逐层展开，并按节点上限裁掉会带出越界节点的边", async () => {
  mocks.selectRowsBy.mockImplementation(async (query) => {
    const values = (query.filters?.[0]?.value ?? []) as string[];
    const rows = values.includes("A")
      ? [{ SRC_ID: "A", DST_ID: "B" }]
      : values.includes("B")
        ? [{ SRC_ID: "B", DST_ID: "C" }]
        : [];
    return { columns: ["SRC_ID", "DST_ID"], rows, rowLimit: 500, truncated: false, statement: "links" };
  });

  const twoHops = await queryLinkNeighborhood(
    { targetId: "target", versionId: "version", definition },
    { seed: { entityType: "客户", keys: [{ CUST_ID: "A" }] }, depth: 2, maxNodes: 10, maxLinks: 10 },
  );
  expect(twoHops.depthReached).toBe(2);
  expect(twoHops.links.map((link) => link.linkRef)).toEqual([
    expect.stringContaining("CUST_ID=A"),
    expect.stringContaining("CUST_ID=B"),
  ]);

  const bounded = await queryLinkNeighborhood(
    { targetId: "target", versionId: "version", definition },
    { seed: { entityType: "客户", keys: [{ CUST_ID: "A" }] }, depth: 2, maxNodes: 2, maxLinks: 10 },
  );
  expect(bounded.links).toHaveLength(1);
  expect(bounded.truncated).toBe(true);
});
