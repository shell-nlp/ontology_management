import { z } from "zod";

/**
 * 本体定义（对象类 / 关系类 / 属性规则）。
 *
 * 这里只保留与图数据库无关的定义结构。落地到具体图库的读写能力
 * （校验必填、同步唯一约束与索引、整体替换图数据）由
 * @/lib/graph 的 GraphStore 适配器实现，不再和 Cypher 绑定。
 */
const propertySchema = z.object({
  name: z.string().trim().min(1).max(120),
  dataType: z.enum(["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"]),
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  indexed: z.boolean().default(false),
});

export const ontologyDefinitionSchema = z.object({
  entityTypes: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).default(""),
    displayProperty: z.string().max(120).optional().default(""),
    properties: z.array(propertySchema).default([]),
  })).default([]),
  relationshipTypes: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    sourceEntityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
    targetEntityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
    properties: z.array(propertySchema).default([]),
  })).default([]),
});

export type OntologyDefinition = z.infer<typeof ontologyDefinitionSchema>;
