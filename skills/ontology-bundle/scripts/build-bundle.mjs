#!/usr/bin/env node
/**
 * 本体包编译器：把「结构化清单」（ontology.blueprint）编译成平台能直接导入的本体包 JSON（ontology.bundle）。
 *
 * 为什么要这一步：让模型直接吐一大坨 bundle JSON，最容易错的两件事是
 *   1) 手写 UUID 与 id 引用 —— 对不上就整包报错；
 *   2) 忘字段 / 写错枚举 —— 格式漂移。
 * 所以改成：**模型只写清单**（用名字引用，不写 id、不写 UUID、不写 format），
 * 由这个脚本统一解析引用、生成 UUID、补齐默认值与格式字段。
 *
 * 用法（Windows / Linux / macOS 通用，只要有 Node 18+）：
 *   node build-bundle.mjs <清单.json>                    # 产出 <标识>.ontology.json（写在清单旁边）
 *   node build-bundle.mjs <清单.json> --out 产物.json     # 指定产物路径
 *   node build-bundle.mjs <清单.json> --check            # 只校验、不写文件
 *   node build-bundle.mjs <清单.json> --stdout           # 把 JSON 打到标准输出
 *
 * 退出码：0 成功；1 清单有问题（引用解析不了 / 结构不对）；2 用法不对。
 *
 * 只用 Node 内置模块，不装依赖、不联网、不读环境变量 —— 拷到哪台机器都能跑。
 * 路径一律走 node:path，所以 Windows 的反斜杠与 Linux/macOS 的正斜杠都认；
 * 带空格的路径记得加引号（PowerShell 用 & 或引号包住即可）。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BUNDLE_FORMAT = "ontology.bundle";
const BUNDLE_FORMAT_VERSION = 1;
const BLUEPRINT_FORMAT = "ontology.blueprint";
const GENERATOR = { name: "ontology-blueprint", version: "1.0.0" };

const DATA_TYPES = ["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"];
const DATA_SOURCE_KINDS = ["ORACLE", "POSTGRES", "MYSQL"];
const RULE_EFFECTS = ["BLOCK", "WARN", "HIDE"];
const EDIT_OPS = ["CREATE_ENTITY", "SET_PROPERTY", "CREATE_RELATIONSHIP"];
const REF_KINDS = ["SUBJECT", "PARAM", "EDIT"];
const VALUE_KINDS = ["PARAM", "CONST", "NOW"];
const OPERATORS = ["EQUALS", "NOT_EQUALS", "IS_TRUTHY", "IS_FALSY", "IS_EMPTY", "IS_NOT_EMPTY"];

/** UUID：优先用 Node 自带的，老版本退回自己拼 v4。 */
function newId() {
  if (typeof randomUUID === "function") return randomUUID();
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 名字归一：解析引用时忽略大小写与空白（「专线产品用户」与「专线产品用户 」是同一个）。 */
function key(name) {
  return text(name).toLowerCase().replace(/\s+/g, "");
}

function slug(value) {
  const ascii = text(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ascii || "ontology";
}

function printHelp() {
  console.log([
    "本体包编译器 —— 把结构化清单编译成平台可导入的 ontology.bundle JSON",
    "",
    "用法：node build-bundle.mjs <清单.json> [选项]",
    "",
    "选项：",
    "  -o, --out <文件>   产物路径（默认：清单旁边的 <标识>.ontology.json）",
    "      --check        只校验与体检，不写文件",
    "      --stdout       把 JSON 打到标准输出（不写文件）",
    "  -q, --quiet        只在出错时输出",
    "  -h, --help         看这段说明",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = { input: "", out: "", stdout: false, check: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" || arg === "-o") {
      options.out = argv[index + 1] ?? "";
      index += 1;
      if (!options.out) throw new UsageError("--out 后面要跟一个文件路径。");
      continue;
    }
    if (arg === "--stdout") { options.stdout = true; continue; }
    if (arg === "--check") { options.check = true; continue; }
    if (arg === "--quiet" || arg === "-q") { options.quiet = true; continue; }
    if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    if (arg.startsWith("-")) throw new UsageError(`未知参数：${arg}`);
    if (options.input) throw new UsageError("只能传一个清单文件。");
    options.input = arg;
  }
  if (!options.input) throw new UsageError("要传一个清单文件，例如：node build-bundle.mjs line-service.blueprint.json");
  return options;
}

class UsageError extends Error {}

/**
 * 编译：把清单里的"名字引用"解析成 id。
 *
 * 两遍走：第一遍给每个实体发 id 并建名字索引（顺便查重名），
 * 第二遍才解析引用 —— 所以清单里的先后顺序不影响引用（可以互相引用）。
 */
function compile(blueprint) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);
  const warn = (message) => warnings.push(message);

  const ontology = isPlainObject(blueprint.ontology) ? blueprint.ontology : {};
  const ontologyName = text(ontology.name);
  if (!ontologyName) fail("清单缺 ontology.name（本体名，界面上显示的就是它）。");

  /** 建一个"名字 → id"的索引；重名直接报错（引用会指向哪个说不清）。 */
  function index(items, kind, idField = "id") {
    const map = new Map();
    for (const item of items) {
      const name = text(item?.name);
      if (!name) { fail(`${kind}里有条目没写 name。`); continue; }
      const normalized = key(name);
      if (map.has(normalized)) {
        fail(`${kind}重名：「${name}」。名字是清单里唯一的引用方式，先改成一个不重复的。`);
        continue;
      }
      const id = newId();
      item[idField] = id;
      map.set(normalized, item);
    }
    return map;
  }

  const groups = asArray(blueprint.groups).map((group) => ({
    id: "", name: text(group?.name), color: text(group?.color),
  }));
  const interfaces = asArray(blueprint.interfaces).map((item) => ({
    id: "", name: text(item?.name), description: text(item?.description),
    properties: asArray(item?.properties), extends: asArray(item?.extends), linkConstraints: asArray(item?.linkConstraints),
  }));
  const objectTypes = asArray(blueprint.objectTypes ?? blueprint.entityTypes).map((item) => ({
    id: "", name: text(item?.name), description: text(item?.description),
    displayProperty: text(item?.displayProperty), group: text(item?.group),
    implements: asArray(item?.implements), properties: asArray(item?.properties), sources: asArray(item?.sources),
  }));
  const relationTypes = asArray(blueprint.relationTypes ?? blueprint.relationshipTypes).map((item) => ({
    id: "", name: text(item?.name), description: text(item?.description),
    source: text(item?.source), target: text(item?.target), properties: asArray(item?.properties),
  }));
  const actionTypes = asArray(blueprint.actionTypes).map((item) => ({
    id: "", name: text(item?.name), code: text(item?.code), description: text(item?.description),
    scope: text(item?.scope), params: asArray(item?.params), edits: asArray(item?.edits),
  }));
  const rules = asArray(blueprint.rules).map((item) => ({
    id: "", name: text(item?.name), effect: text(item?.effect) || "BLOCK", action: text(item?.action),
    priority: Number.isFinite(item?.priority) ? item.priority : 0, enabled: item?.enabled !== false,
    conditions: asArray(item?.conditions), message: text(item?.message),
  }));
  const dataSources = asArray(blueprint.dataSources).map((item) => ({
    id: "", name: text(item?.name), kind: text(item?.kind).toUpperCase(),
    host: text(item?.host), port: Number(item?.port) || 0,
    databaseName: text(item?.databaseName), schemaName: text(item?.schemaName),
  }));

  const groupByName = index(groups, "概念分组");
  const interfaceByName = index(interfaces, "接口");
  const objectTypeByName = index(objectTypes, "对象类型");
  const relationTypeByName = index(relationTypes, "关系类型");
  const actionTypeByName = index(actionTypes, "动作");
  const ruleByName = index(rules, "规则");
  const dataSourceByName = index(dataSources, "数据资源");

  /** 解析一个"按名字引用"的字段：解析不到就报错，并把可选项列出来（模型据此自己改对）。 */
  function resolve(map, name, kind, where, { optional = false } = {}) {
    const raw = text(name);
    if (!raw) {
      if (!optional) fail(`${where}没写：要填一个${kind}的名字。`);
      return "";
    }
    const hit = map.get(key(raw));
    if (!hit) {
      const available = [...map.values()].map((item) => item.name).join("、") || "（清单里一个都没有）";
      fail(`${where}指向了不存在的${kind}「${raw}」。当前清单里有：${available}。`);
      return "";
    }
    return hit.id;
  }

  // ---- 属性 ----
  function compileProperties(items, where) {
    const seen = new Set();
    return asArray(items).map((property) => {
      const name = text(property?.name);
      if (!name) fail(`${where}有个属性没写 name。`);
      else if (seen.has(key(name))) fail(`${where}的属性「${name}」重复了。`);
      seen.add(key(name));
      const dataType = text(property?.dataType).toUpperCase() || "TEXT";
      if (!DATA_TYPES.includes(dataType)) fail(`${where}的属性「${name}」dataType 不认识：${dataType}（可选：${DATA_TYPES.join(" / ")}）。`);
      return {
        name,
        displayName: text(property?.displayName),
        description: text(property?.description),
        dataType,
        required: property?.required === true,
        unique: property?.unique === true,
        indexed: property?.indexed === true,
        ...(text(property?.sourceField) ? { sourceField: text(property.sourceField) } : {}),
        ...(text(property?.source) ? { sourceId: text(property.source) } : {}),
      };
    });
  }

  // ---- 对象类型 ----
  const compiledObjectTypes = objectTypes.map((item) => {
    const where = `对象类型「${item.name}」`;
    const properties = compileProperties(item.properties, where);
    const sources = item.sources.map((source, position) => {
      const id = text(source?.id) || (position === 0 ? "primary" : `source${position + 1}`);
      return {
        id,
        dataSourceId: resolve(dataSourceByName, source?.dataSource, "数据资源", `${where}的第 ${position + 1} 份来源`, { optional: true }),
        schema: text(source?.schema),
        view: text(source?.view),
        primaryKey: asArray(source?.primaryKey).map(text).filter(Boolean),
        titleField: text(source?.titleField),
      };
    });
    const sourceIds = new Set(sources.map((source) => source.id));
    if (sourceIds.size !== sources.length) fail(`${where}的 sources[].id 重复了。`);
    for (const property of properties) {
      if (property.sourceId && !sourceIds.has(property.sourceId)) {
        fail(`${where}的属性「${property.name}」source 指向了不存在的来源 id「${property.sourceId}」（本类型有：${[...sourceIds].join("、") || "无"}）。`);
      }
    }

    // 只做"清单内部自洽"的体检；建模层面的判断以平台的「建模体检」为准（规则码见 modeling-rules.md §9）。
    if (!properties.length) warn(`ENTITY_NO_PROPERTIES：${where}一个属性都没有。`);
    if (item.displayProperty && !properties.some((property) => property.name === item.displayProperty)) {
      warn(`ENTITY_DISPLAY_PROPERTY_MISSING：${where}的展示属性「${item.displayProperty}」不在它的属性里。`);
    }
    const bound = sources.filter((source) => source.dataSourceId && source.view);
    if (bound.length && !properties.some((property) => property.sourceField)) {
      warn(`ENTITY_SOURCE_UNMAPPED：${where}绑了表，但没有任何属性写 sourceField。`);
    } else if (bound.length) {
      const mapped = new Set(properties.map((property) => property.sourceField).filter(Boolean));
      const unmappedKeys = (bound[0].primaryKey ?? []).filter((column) => !mapped.has(column));
      if (unmappedKeys.length) warn(`ENTITY_PRIMARY_KEY_UNMAPPED：${where}的主键列「${unmappedKeys.join("、")}」没有属性映射过去。`);
      const unmappedRequired = properties.filter((property) => property.required && !property.sourceField);
      if (unmappedRequired.length) warn(`ENTITY_REQUIRED_PROPERTY_UNMAPPED：${where}的必填属性「${unmappedRequired.map((property) => property.name).join("、")}」没有映射列。`);
    }

    return {
      id: item.id,
      name: item.name,
      description: item.description,
      displayProperty: item.displayProperty,
      groupId: resolve(groupByName, item.group, "概念分组", `${where}的 group`, { optional: true }),
      implements: item.implements.map((name) => resolve(interfaceByName, name, "接口", `${where}实现的接口`)).filter(Boolean),
      properties,
      sources,
    };
  });

  // ---- 接口 ----
  const compiledInterfaces = interfaces.map((item) => {
    const where = `接口「${item.name}」`;
    const linkConstraints = item.linkConstraints.map((constraint) => {
      const targetName = text(constraint?.target);
      const declaredKind = text(constraint?.targetKind).toUpperCase();
      const asObjectType = objectTypeByName.get(key(targetName));
      const asInterface = interfaceByName.get(key(targetName));
      // 同名时优先按显式声明，其次对象类型（更常见），最后接口。
      const targetKind = declaredKind === "INTERFACE" || declaredKind === "OBJECT_TYPE"
        ? declaredKind
        : (asObjectType ? "OBJECT_TYPE" : asInterface ? "INTERFACE" : "OBJECT_TYPE");
      const map = targetKind === "INTERFACE" ? interfaceByName : objectTypeByName;
      return {
        id: newId(),
        name: text(constraint?.name),
        description: text(constraint?.description),
        targetKind,
        targetId: resolve(map, targetName, targetKind === "INTERFACE" ? "接口" : "对象类型", `${where}的关系约束「${text(constraint?.name)}」的 target`),
        cardinality: text(constraint?.cardinality).toUpperCase() === "ONE" ? "ONE" : "MANY",
        required: constraint?.required === true,
      };
    });
    const properties = compileProperties(item.properties, where);
    if (!properties.length && !linkConstraints.length) warn(`INTERFACE_EMPTY：${where}既没有属性也没有关系约束。`);
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      properties,
      extends: item.extends.map((name) => resolve(interfaceByName, name, "接口", `${where}继承的接口`)).filter(Boolean),
      linkConstraints,
    };
  });

  // ---- 关系类型 ----
  const compiledRelationTypes = relationTypes.map((item) => {
    const where = `关系类型「${item.name}」`;
    const source = resolve(objectTypeByName, item.source, "对象类型", `${where}的 source`);
    const target = resolve(objectTypeByName, item.target, "对象类型", `${where}的 target`);
    if (!source || !target) warn(`RELATION_ENDPOINT_MISSING：${where}的起点或终点没解析出来。`);
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      sourceEntityTypeId: source,
      targetEntityTypeId: target,
      properties: compileProperties(item.properties, where),
    };
  });

  // ---- 动作 ----
  const compiledActionTypes = actionTypes.map((item) => {
    const where = `动作「${item.name}」`;
    const paramCodes = new Set();
    const params = item.params.map((parameter) => {
      const code = text(parameter?.code);
      if (!code) fail(`${where}有个入参没写 code。`);
      else if (paramCodes.has(code)) fail(`${where}的入参 code「${code}」重复。`);
      paramCodes.add(code);
      const kind = text(parameter?.kind).toUpperCase() === "ENTITY_REF" ? "ENTITY_REF" : "VALUE";
      return {
        code,
        name: text(parameter?.name),
        kind,
        entityTypeId: kind === "ENTITY_REF" ? resolve(objectTypeByName, parameter?.entityType, "对象类型", `${where}的入参「${text(parameter?.name)}」的 entityType`) : "",
        dataType: DATA_TYPES.includes(text(parameter?.dataType).toUpperCase()) ? text(parameter.dataType).toUpperCase() : "TEXT",
        required: parameter?.required === true,
      };
    });
    const aliases = new Set();
    const edits = item.edits.map((edit) => {
      const op = text(edit?.op).toUpperCase();
      if (!EDIT_OPS.includes(op)) fail(`${where}的写操作 op 不认识：${text(edit?.op)}（可选：${EDIT_OPS.join(" / ")}）。`);
      const alias = text(edit?.alias);
      if (op === "CREATE_ENTITY") {
        if (!alias) fail(`${where}的 CREATE_ENTITY 缺 alias（后续步骤要按它引用新对象）。`);
        else aliases.add(alias);
      }
      const ref = (value, field) => {
        const kind = text(value?.kind).toUpperCase() || "SUBJECT";
        if (!REF_KINDS.includes(kind)) fail(`${where}的 ${field}.kind 不认识：${text(value?.kind)}。`);
        const code = text(value?.code);
        if (kind === "PARAM" && code && !paramCodes.has(code)) fail(`${where}的 ${field} 引用了不存在的入参「${code}」。`);
        if (kind === "EDIT" && code && !aliases.has(code)) fail(`${where}的 ${field} 引用了不存在的别名「${code}」。`);
        return { kind, code };
      };
      return {
        op,
        alias,
        entityTypeId: text(edit?.entityType) ? resolve(objectTypeByName, edit.entityType, "对象类型", `${where}的 ${op}.entityType`) : "",
        relationshipTypeId: text(edit?.relationshipType) ? resolve(relationTypeByName, edit.relationshipType, "关系类型", `${where}的 ${op}.relationshipType`) : "",
        entityRef: ref(edit?.entityRef, `${op}.entityRef`),
        sourceRef: ref(edit?.sourceRef, `${op}.sourceRef`),
        targetRef: ref(edit?.targetRef, `${op}.targetRef`),
        assignments: asArray(edit?.assignments).map((assignment) => {
          const valueKind = text(assignment?.value?.kind).toUpperCase() || "CONST";
          if (!VALUE_KINDS.includes(valueKind)) fail(`${where}的赋值 value.kind 不认识：${text(assignment?.value?.kind)}。`);
          const valueCode = text(assignment?.value?.code);
          if (valueKind === "PARAM" && valueCode && !paramCodes.has(valueCode)) fail(`${where}的赋值引用了不存在的入参「${valueCode}」。`);
          return {
            property: text(assignment?.property),
            value: { kind: valueKind, code: valueCode, value: text(assignment?.value?.value) },
          };
        }),
      };
    });
    return {
      id: item.id,
      name: item.name,
      code: item.code || slug(item.name),
      description: item.description,
      scopeEntityTypeId: resolve(objectTypeByName, item.scope, "对象类型", `${where}的 scope（动作定义在哪个对象类型上）`),
      params,
      edits,
    };
  });

  // ---- 规则 ----
  const compiledRules = rules.map((item) => {
    const where = `规则「${item.name}」`;
    const effect = RULE_EFFECTS.includes(item.effect.toUpperCase()) ? item.effect.toUpperCase() : "BLOCK";
    if (!(item.conditions ?? []).length) warn(`RULE_WITHOUT_CONDITION：${where}没有任何条件。`);
    if ((effect === "BLOCK" || effect === "WARN") && !item.message) warn(`RULE_EMPTY_MESSAGE：${where}没写给用户看的原因（message）。`);
    if (effect === "HIDE" && !text(item.action)) fail(`${where}是 HIDE：隐藏是"动作在满足条件的对象上出不出来"，必须绑定一个具体动作。`);
    return {
      id: item.id,
      name: item.name,
      effect,
      priority: item.priority,
      enabled: item.enabled,
      actionId: resolve(actionTypeByName, item.action, "动作", `${where}绑定的动作`, { optional: true }),
      conditions: item.conditions.map((condition) => {
        const subject = isPlainObject(condition?.subject) ? condition.subject : {};
        const kind = text(subject.kind).toUpperCase() || "SUBJECT";
        if (!REF_KINDS.includes(kind)) fail(`${where}的条件 subject.kind 不认识：${text(subject.kind)}。`);
        const operator = text(condition?.operator).toUpperCase();
        if (!OPERATORS.includes(operator)) fail(`${where}的条件 operator 不认识：${text(condition?.operator)}（可选：${OPERATORS.join(" / ")}）。`);
        return {
          subject: {
            kind,
            code: text(subject.code),
            relationshipTypeId: text(subject.relationshipType) ? resolve(relationTypeByName, subject.relationshipType, "关系类型", `${where}的条件里跳转用的关系类型`) : "",
            direction: text(subject.direction).toUpperCase() === "IN" ? "IN" : "OUT",
          },
          property: text(condition?.property),
          operator,
          compareValue: text(condition?.compareValue),
        };
      }),
      message: item.message,
    };
  });

  // ---- 数据资源 ----
  const compiledDataSources = dataSources.map((item) => {
    if (!DATA_SOURCE_KINDS.includes(item.kind)) fail(`数据资源「${item.name}」的 kind 不认识：${item.kind || "（空）"}（可选：${DATA_SOURCE_KINDS.join(" / ")}）。`);
    if (!item.host) fail(`数据资源「${item.name}」没写 host。`);
    return { id: item.id, name: item.name, kind: item.kind, host: item.host, port: item.port, databaseName: item.databaseName, schemaName: item.schemaName };
  });

  const bundle = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    generator: GENERATOR,
    ontology: {
      identifier: text(ontology.identifier) || slug(ontologyName),
      name: ontologyName,
      description: text(ontology.description),
      color: text(ontology.color),
      tags: asArray(ontology.tags).map(text).filter(Boolean),
    },
    statistics: {
      objectTypes: compiledObjectTypes.length,
      relationTypes: compiledRelationTypes.length,
      actionTypes: compiledActionTypes.length,
      rules: compiledRules.length,
      objects: 0,
      relationships: 0,
    },
    dataSources: compiledDataSources,
    definition: {
      groups: groups.map((group) => ({ id: group.id, name: group.name, color: group.color })),
      interfaces: compiledInterfaces,
      entityTypes: compiledObjectTypes,
      relationshipTypes: compiledRelationTypes,
      actionTypes: compiledActionTypes,
      rules: compiledRules,
    },
  };

  void ruleByName; // 规则目前不互相引用；留着索引是为了以后加"规则依赖"时直接可用。
  return { bundle, errors, warnings };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof UsageError ? `用法不对：${error.message}` : String(error));
    console.error("用 --help 看用法。");
    process.exit(2);
    return;
  }

  const inputPath = path.resolve(options.input);
  let blueprint;
  try {
    blueprint = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (error) {
    console.error(`读不了清单文件：${inputPath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }
  if (!isPlainObject(blueprint)) {
    console.error("清单最外层必须是一个 JSON 对象。");
    process.exit(1);
    return;
  }
  if (blueprint.format && blueprint.format !== BLUEPRINT_FORMAT) {
    console.error(`这份文件的 format 是「${blueprint.format}」，不是清单（${BLUEPRINT_FORMAT}）。`);
    console.error("要导入平台的是编译产物 .ontology.json；清单要先过这个脚本。");
    process.exit(1);
    return;
  }

  const { bundle, errors, warnings } = compile(blueprint);
  const say = (...args) => { if (!options.quiet) console.log(...args); };

  if (warnings.length) {
    say(`⚠ 体检提醒 ${warnings.length} 条（不挡导入，平台「建模体检」会说同样的话，规则码见 modeling-rules.md §9）：`);
    for (const item of warnings) say(`  - ${item}`);
  }

  if (errors.length) {
    console.error(`✗ 清单有 ${errors.length} 处问题，先改完再编译：`);
    for (const item of errors) console.error(`  - ${item}`);
    process.exit(1);
    return;
  }

  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  if (options.stdout) {
    process.stdout.write(json);
    return;
  }
  if (options.check) {
    say(`✓ 清单可以编译：${bundle.statistics.objectTypes} 个对象类型、${bundle.statistics.relationTypes} 个关系类型、${bundle.definition.interfaces.length} 个接口、${bundle.statistics.actionTypes} 个动作、${bundle.statistics.rules} 条规则（--check 不写文件）。`);
    return;
  }

  const outPath = options.out
    ? path.resolve(options.out)
    : path.join(path.dirname(inputPath), `${bundle.ontology.identifier}.ontology.json`);
  writeFileSync(outPath, json, "utf8");
  say(`✓ 编译完成：${outPath}`);
  say(`  ${bundle.statistics.objectTypes} 个对象类型、${bundle.statistics.relationTypes} 个关系类型、${bundle.definition.interfaces.length} 个接口、${bundle.statistics.actionTypes} 个动作、${bundle.statistics.rules} 条规则、${bundle.dataSources.length} 个数据资源。`);
  say("  下一步：平台左侧「本体」→「导入本体包」→ 选这个文件 → 选存储资源 → 导入 → 校验 → 发布。");
}

main();
