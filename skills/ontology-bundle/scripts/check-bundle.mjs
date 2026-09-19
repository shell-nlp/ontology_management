#!/usr/bin/env node
/**
 * 本体包结构自检：给**手写**的 `.ontology.json` 用（走编译器的路径不需要它 —— 编译器产出的结构一定合法）。
 *
 * 用法（Windows / Linux / macOS 通用）：
 *   node check-bundle.mjs <包.json>
 * 退出码：0 通过；1 有问题。
 *
 * 查的都是"机器能查"的：格式字段、id 是不是 UUID、id 有没有重复、引用有没有指向不存在的 id、
 * 规则有没有条件、数据资源里有没有混进账号密码。**语义**（接口实现、动作作用对象、命名是否业务化）
 * 机器查不出来，见 SKILL.md 的人工清单。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("用法：node check-bundle.mjs <包.json>");
    process.exit(2);
  }
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    console.error(`读不了或不是合法 JSON：${file}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const fail = [];
  const d = bundle?.definition ?? {};

  if (bundle?.format !== "ontology.bundle") fail.push("format 必须是 ontology.bundle");
  if (!bundle?.exportedAt) fail.push("缺 exportedAt");
  if (!bundle?.ontology?.name) fail.push("缺 ontology.name");
  if (!d || typeof d !== "object") fail.push("缺 definition");

  const ids = new Set();
  const addId = (id, where) => {
    if (!UUID.test(id ?? "")) return fail.push(`${where} 的 id 不是 UUID：${id}`);
    if (ids.has(id)) fail.push(`${where} 的 id 重复：${id}`);
    ids.add(id);
  };
  // 数据资源的 id 也在同一个索引里 —— 对象类型的 sources[].dataSourceId 指的是它（漏了就会误报"指向不存在的 id"）。
  (bundle?.dataSources ?? []).forEach((source, index) => addId(source.id, `dataSources[${index}]`));
  (d.groups ?? []).forEach((group, index) => addId(group.id, `groups[${index}]`));
  (d.interfaces ?? []).forEach((item, index) => {
    addId(item.id, `interfaces[${index}]`);
    (item.linkConstraints ?? []).forEach((constraint, position) => addId(constraint.id, `interfaces[${index}].linkConstraints[${position}]`));
  });
  (d.entityTypes ?? []).forEach((item, index) => addId(item.id, `entityTypes[${index}]`));
  (d.relationshipTypes ?? []).forEach((item, index) => addId(item.id, `relationshipTypes[${index}]`));
  (d.actionTypes ?? []).forEach((item, index) => addId(item.id, `actionTypes[${index}]`));
  (d.rules ?? []).forEach((item, index) => addId(item.id, `rules[${index}]`));

  const need = (id, where) => { if (id && !ids.has(id)) fail.push(`${where} 指向不存在的 id：${id}`); };
  (d.entityTypes ?? []).forEach((entity) => {
    need(entity.groupId, `${entity.name}.groupId`);
    (entity.implements ?? []).forEach((id) => need(id, `${entity.name}.implements`));
    const sourceIds = new Set((entity.sources ?? []).map((source) => source.id));
    (entity.properties ?? []).forEach((property) => { if (property.sourceId) need(property.sourceId, `${entity.name}.${property.name}.sourceId`); });
    if (sourceIds.size !== (entity.sources ?? []).length) fail.push(`${entity.name} 的 sources[].id 重复`);
    (entity.sources ?? []).forEach((source, index) => {
      if (source.dataSourceId) need(source.dataSourceId, `${entity.name}.sources[${index}].dataSourceId`);
      if (!source.dataSourceId && source.view) fail.push(`${entity.name} 的第 ${index + 1} 份来源填了表名但没接数据资源（导入后这份绑定会留空）`);
    });
  });
  (d.relationshipTypes ?? []).forEach((relation) => {
    need(relation.sourceEntityTypeId, `${relation.name} 起点`);
    need(relation.targetEntityTypeId, `${relation.name} 终点`);
    // 键映射写的是"连接列 → 对象类型的属性"，属性按名字指；指到不存在的属性时发布校验会拦，这里先提醒。
    for (const [side, entityId, mappings] of [
      ["起点", relation.sourceEntityTypeId, relation.sourceKeyMappings],
      ["终点", relation.targetEntityTypeId, relation.targetKeyMappings],
    ]) {
      const entity = (d.entityTypes ?? []).find((item) => item.id === entityId);
      const known = new Set((entity?.properties ?? []).map((property) => property.name));
      (mappings ?? []).forEach((mapping) => {
        if (mapping?.entityProperty && known.size && !known.has(mapping.entityProperty)) fail.push(`${relation.name} 的${side}键映射指向了 ${entity?.name} 上不存在的属性 ${mapping.entityProperty}`);
      });
    }
  });
  (d.interfaces ?? []).forEach((item) => {
    (item.extends ?? []).forEach((id) => need(id, `${item.name}.extends`));
    (item.linkConstraints ?? []).forEach((constraint) => need(constraint.targetId, `${item.name}.${constraint.name}`));
  });
  (d.actionTypes ?? []).forEach((action) => {
    need(action.scopeEntityTypeId, `${action.name}.scopeEntityTypeId`);
    (action.params ?? []).forEach((parameter) => {
      if (parameter.kind === "ENTITY_REF") need(parameter.entityTypeId, `${action.name}.${parameter.code}`);
    });
  });
  (d.rules ?? []).forEach((rule) => {
    need(rule.actionId, `${rule.name}.actionId`);
    if (!(rule.conditions ?? []).length) fail.push(`规则「${rule.name}」没有条件`);
  });

  // 连接坐标里绝不该有账号密码 —— 这一条比结构错误更要紧，单独查。
  for (const source of bundle?.dataSources ?? []) {
    for (const key of ["password", "passwd", "secret", "username", "user"]) {
      if (source?.[key] !== undefined) fail.push(`数据资源「${source.name ?? "未命名"}」里有 ${key} —— 包里只能有连接坐标，不能有账号密码`);
    }
  }

  if (fail.length) {
    console.error(`✗ 结构自检没通过，${fail.length} 处问题：`);
    for (const item of fail) console.error(`  - ${item}`);
    process.exit(1);
  }
  const counts = [
    `${(d.entityTypes ?? []).length} 个对象类型`,
    `${(d.relationshipTypes ?? []).length} 个关系类型`,
    `${(d.interfaces ?? []).length} 个接口`,
    `${(d.actionTypes ?? []).length} 个动作`,
    `${(d.rules ?? []).length} 条规则`,
  ].join("、");
  console.log(`✓ 结构自检通过：${counts}。`);
  console.log("  语义（接口实现、动作作用对象、命名是否业务化）机器查不出来，按 SKILL.md 的人工清单再过一遍。");
}

main();
