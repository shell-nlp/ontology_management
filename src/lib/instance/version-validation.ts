import { validateActionDefinition } from "@/lib/instance/action-engine";
import { parsePropertyValues } from "@/lib/instance/instance-property-editor";
import { primaryKeyConflicts } from "@/lib/ontology/object-identity";
import { validateInterfaceImplementations, validateInterfaces } from "@/lib/ontology/interfaces";
import { linkSourceViolations } from "@/lib/ontology/link-source";
import { metricViolations } from "@/lib/ontology/metrics";
import { relationshipKeyViolations } from "@/lib/ontology/relationship-keys";
import { validateEntitySources } from "@/lib/ontology/sources";
import type { SnapshotNode, VersionSnapshot } from "@/lib/versioning/snapshot";

const MAX_INDEXED_VALUE_BYTES = 8191;

/** 发布前检查的一条结论：severity 为 WARN 的只是提醒，不挡发布。 */
export type SnapshotViolation = { rule: string; message: string; count: number; severity?: "WARN" };

export function validateVersionSnapshot(snapshot: VersionSnapshot, knownSourceIds?: readonly string[]) {
  const violations: SnapshotViolation[] = [];
  /*
   * 对象身份是 (对象类型, 主键)：同一个对象类型里主键重复 = 本体里同一个对象存在两份，
   * 后续按主键取数、写回、索引都会打架，所以这一条**挡发布**（不是提醒）。
   */
  for (const conflict of primaryKeyConflicts(snapshot.definition, snapshot.nodes)) {
    violations.push({
      rule: `${conflict.typeName}.主键`,
      message: `主键重复：「${conflict.key}」出现在 ${conflict.ids.length} 个「${conflict.typeName}」对象上（${conflict.ids.join("、")}）。同一个对象类型里主键必须唯一。`,
      count: conflict.ids.length,
    });
  }
  // 来源绑定（一个类挂多份表，按主键合并属性）是建模信息，图里看不出来，只能查定义。
  for (const entity of snapshot.definition.entityTypes) violations.push(...validateEntitySources(entity, { knownSourceIds }));
  // 关系类型的键映射同理：它是定义层的声明，指向不存在的属性时换台机器导入就是悬空引用。
  for (const item of relationshipKeyViolations(snapshot.definition)) violations.push(item);
  // 关系类型的数据来源（D2）：配了但取不出实例的话，图上看不到边，这里提醒一句（不挡发布）。
  for (const item of linkSourceViolations(snapshot.definition)) violations.push(item);
  // 指标：指向不存在的对象类型 / 属性就是悬空引用，模型拿着它也算不出数。
  for (const item of metricViolations(snapshot.definition)) violations.push(item);
  const entityTypes = new Map(snapshot.definition.entityTypes.map((entity) => [entity.name, entity]));
  const relationshipTypes = new Map(snapshot.definition.relationshipTypes.map((relationship) => [relationship.name, relationship]));
  const entityTypesById = new Map(snapshot.definition.entityTypes.map((entity) => [entity.id, entity]));
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  /*
   * 主键不能重复：勾了「主键」的属性按**整组值**判重（复合主键单列重复不算，整组一样才算）。
   * 绑了来源的类型另有 `primaryKeyConflicts` 按对象身份再判一次，两条互补、都挡发布。
   * 单列主键值太长会塞不进检索索引的唯一键，也一起挡在发布前。
   */
  const primaryKeyValues = new Map<string, Set<string>>();
  const oversizedPrimaryKey = new Map<string, { typeName: string; propertyName: string; nodes: SnapshotNode[] }>();
  for (const node of snapshot.nodes) {
    const managed = node.labels.filter((label) => entityTypes.has(label));
    if (managed.length !== 1 || managed.length !== node.labels.length) {
      violations.push({ rule: node.id, message: "对象必须且只能使用一个草稿中定义的对象类型。", count: 1 });
      continue;
    }
    const type = entityTypes.get(managed[0])!;
    const properties = type.properties;
    const businessProperties = Object.fromEntries(Object.entries(node.properties).filter(([key]) => key !== "fx" && key !== "fy"));
    try { parsePropertyValues(properties, businessProperties); } catch (error) {
      violations.push({ rule: `${type.name}:${node.id}`, message: error instanceof Error ? error.message : "对象属性校验失败。", count: 1 });
    }
    const keyProperties = properties.filter((item) => item.primaryKey);
    if (keyProperties.length && keyProperties.every((item) => node.properties[item.name] != null)) {
      const value = JSON.stringify(keyProperties.map((item) => node.properties[item.name]));
      const seen = primaryKeyValues.get(type.id) ?? new Set<string>();
      if (seen.has(value)) {
        const keyText = keyProperties.map((item) => `${item.name}=${String(node.properties[item.name])}`).join("&");
        violations.push({ rule: `${type.name}.${keyProperties.map((item) => item.name).join("+")}`, message: `主键重复：「${keyText}」在本体里出现了不止一个对象。`, count: 1 });
      }
      seen.add(value);
      primaryKeyValues.set(type.id, seen);
    }
    for (const property of keyProperties) {
      if (node.properties[property.name] == null) continue;
      const raw = node.properties[property.name];
      const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (Buffer.byteLength(serialized, "utf8") > MAX_INDEXED_VALUE_BYTES) {
        const rule = `${type.name}.${property.name}`;
        const entry = oversizedPrimaryKey.get(rule) ?? { typeName: type.name, propertyName: property.name, nodes: [] };
        entry.nodes.push(node);
        oversizedPrimaryKey.set(rule, entry);
      }
    }
  }
  for (const relationship of snapshot.relationships) {
    const type = relationshipTypes.get(relationship.type);
    const source = nodes.get(relationship.sourceId);
    const target = nodes.get(relationship.targetId);
    if (!type) { violations.push({ rule: relationship.id, message: "关系使用了草稿中不存在的关系类型。", count: 1 }); continue; }
    if (!source || !target) { violations.push({ rule: relationship.id, message: "关系引用了不存在的对象。", count: 1 }); continue; }
    const sourceType = entityTypesById.get(type.sourceEntityTypeId);
    const targetType = entityTypesById.get(type.targetEntityTypeId);
    if (!sourceType || !targetType || !source.labels.includes(sourceType.name) || !target.labels.includes(targetType.name)) {
      violations.push({ rule: `${type.name}:${relationship.id}`, message: "关系端点不符合草稿中的对象类型契约。", count: 1 });
    }
    try { parsePropertyValues(type.properties, relationship.properties); } catch (error) {
      violations.push({ rule: `${type.name}:${relationship.id}`, message: error instanceof Error ? error.message : "关系属性校验失败。", count: 1 });
    }
  }
  for (const entry of oversizedPrimaryKey.values()) {
    const displayProperty = snapshot.definition.entityTypes.find((type) => type.name === entry.typeName)?.displayProperty;
    const fallbackKeys = ["表名", "名称", "name", "title", "id"];
    const involved = entry.nodes.map((node) => {
      const keys = displayProperty ? [displayProperty, ...fallbackKeys] : fallbackKeys;
      const readable = keys.map((key) => node.properties[key]).find((value) => (typeof value === "string" && value.trim()) || typeof value === "number");
      const name = readable != null ? String(readable) : node.id;
      const shortName = name.length > 60 ? `${name.slice(0, 60)}…` : name;
      const raw = String(node.properties[entry.propertyName] ?? "");
      const snippet = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
      return `「${shortName}」(${node.id}，${entry.propertyName}开头：${snippet})`;
    }).join("、");
    violations.push({ rule: `${entry.typeName}.${entry.propertyName}`, message: `主键属性「${entry.propertyName}」有 ${entry.nodes.length} 个值的长度超过 ${MAX_INDEXED_VALUE_BYTES} 字节（约 8KB），不适合当主键。涉及：${involved}。请换一个短一点的主键列，或缩短字段内容后重试。`, count: entry.nodes.length });
  }
  /*
   * 接口是抽象契约：声明实现了就必须满足它的必填属性与必填关系约束，否则应用拿到的是缺字段的对象。
   * 这两条校验原先只挂在接口管理页（客户端提示），发布路径上漏了 —— 于是"接口页写着还差 2 项"的草稿照样能发布。
   * 接进发布前校验后，界面上的承诺（发布前校验会拦住没满足的实现）才成立。
   */
  for (const item of [...validateInterfaces(snapshot.definition), ...validateInterfaceImplementations(snapshot.definition)]) {
    violations.push({ rule: item.rule, message: item.message, count: item.count });
  }
  const actionViolations: SnapshotViolation[] = validateActionDefinition(snapshot.definition);
  return [...violations, ...actionViolations];
}
