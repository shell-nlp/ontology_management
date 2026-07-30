import { ontologyDefinitionSchema } from "@/lib/ontology";
import { platformQuery } from "@/lib/platform-db";

export async function getPublishedOntology(targetId: string) {
  const result = await platformQuery<{ definition: unknown }>(
    `SELECT definition FROM ontology_platform.ontology_versions
     WHERE target_id = $1 AND status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 1`, [targetId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("该目标尚未发布本体，不能管理实体或关系。");
  return ontologyDefinitionSchema.parse(row.definition);
}

export function quoteCypherIdentifier(identifier: string) {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

export function validatePropertyValues(
  properties: { name: string; required: boolean }[],
  values: Record<string, unknown>,
) {
  const allowed = new Set(properties.map((property) => property.name));
  for (const name of Object.keys(values)) if (!allowed.has(name)) throw new Error(`属性 ${name} 未在已发布类型中定义。`);
  for (const property of properties) if (property.required && (values[property.name] === undefined || values[property.name] === null || values[property.name] === "")) throw new Error(`缺少必填属性：${property.name}。`);
}
