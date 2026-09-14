import type { DataSourceKind } from "@/lib/data-source/types";

/**
 * 表 / 视图名字的两种写法之间的转换。
 *
 * 界面上、本体概览里、给模型的上下文里统一写全「模式.表」（例如 `GISTOOLS.TB_DIC_AREA_CODE`），
 * 因为一张表属于哪个模式是它身份的一部分；而数据字典查询要的是拆开的两段裸名字。
 * 这一层是两者之间**唯一**的转换点：认双引号 / 反引号 / 方括号三种引用方式，大小写原样保留。
 */

/** 标识符引用：PostgreSQL / Oracle 用双引号，MySQL 用反引号；内部同类引号翻倍转义。 */
export function quoteIdentifier(kind: DataSourceKind, name: string) {
  if (kind === "MYSQL") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** 表/视图的完整限定名；schema 为空时只写对象名。 */
export function qualifiedName(kind: DataSourceKind, schema: string | undefined, name: string) {
  const target = quoteIdentifier(kind, name);
  return schema ? `${quoteIdentifier(kind, schema)}.${target}` : target;
}

/**
 * 拆「模式.表」：`GISTOOLS.TB_X`、`"GISTOOLS"."TB_X"`、`` `库`.`表` ``、`[库].[表]` 都认。
 * 段数超过两段时取最后两段（前面的当库名一类的限定，用不到）；只有一段就是裸对象名。
 */
export function splitObjectName(raw: string): { schema?: string; name: string } {
  const segments: string[] = [];
  const pattern = /"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|([^.\[\]"`]+)/g;
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (value) segments.push(value);
  }
  if (!segments.length) return { name: raw.trim() };
  if (segments.length === 1) return { name: segments[0] };
  return { schema: segments[segments.length - 2], name: segments[segments.length - 1] };
}

/**
 * 候选模式，按优先级从高到低去重（大小写不敏感）：名字里写的模式 → 调用方给的模式 → 数据资源登记的模式。
 * 查字典时几个候选一起查，再按这个顺序挑 —— 名字里写了就用名字里的，没写才退回登记的。
 */
export function candidateOwners(...values: Array<string | undefined>) {
  const owners: string[] = [];
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed && !owners.some((item) => item.toUpperCase() === trimmed.toUpperCase())) owners.push(trimmed);
  }
  return owners;
}

/**
 * 在结构清单里按「名字 + 模式优先级」挑一条。
 * 所有候选模式都对不上时退回同名对象 —— 登记的模式与实际不符时不至于查不到；
 * 返回的那条带着库里真实的模式，后续读字段、拼限定名都按它来。
 */
export function pickNamedObject<T extends { schema: string; name: string }>(items: T[], wanted: { owners: string[]; name: string }): T | null {
  const name = wanted.name.toLowerCase();
  const byName = items.filter((item) => item.name.toLowerCase() === name);
  if (byName.length <= 1) return byName[0] ?? null;
  for (const owner of wanted.owners) {
    const hit = byName.find((item) => item.schema.toLowerCase() === owner.toLowerCase());
    if (hit) return hit;
  }
  return byName[0];
}
