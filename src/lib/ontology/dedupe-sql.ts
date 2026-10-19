import { quoteIdentifier } from "@/lib/shared/server/sql-object-name";
import type { DataSourceKind } from "@/lib/shared/common/data-source-kind";

/**
 * 「按规则生成取数口径」——**不写 SQL 也能得到一段确定的去重口径**。
 *
 * 为什么需要它：手写 `ROW_NUMBER() ... PARTITION BY` 时最容易犯两个错 ——
 * ① 忘了写 `ORDER BY`（或者按不唯一的列排）→ 留哪一行变成"任选"，重建一次属性就可能变；
 * ② 该按哪个日期列排、表里根本没有日期列，写的人只能自己碰。
 * 这一层把这个决定变成两个下拉 + 一次校验，生成出来的 SQL 一定是确定的。
 *
 * 纯函数（不认识驱动、不连库）：界面拿它填 SQL 框，测试直接摆最小字段清单。
 */

/** 一个"去重规则"：按什么分组（一个对象一行）、按什么取那一行。 */
export type DedupeRule = {
  /** 分组键：一个对象一行（一般就是对象类型的主键列）。 */
  keyColumns: readonly string[];
  /** 取值依据：按这一列排，保留第一条。 */
  orderColumn: string;
  /** 取最新（DESC，默认）还是取最早（ASC）。 */
  direction?: "DESC" | "ASC";
};

/**
 * 名字像日期/时间的列也算候选：很多表的日期是**字符串**存的（`VARCHAR2`），只看类型会漏掉。
 * 结尾必须真的是日期/时间的写法 —— `_TS` / `_DT` 算，**光 `TS` 不算**（`STATS` 这种状态列会被误判）。
 */
const DATE_LIKE_NAME = /(?:DATE|TIME|DAY|TIMESTAMP|_TS|_DT)$/i;

/**
 * 能拿来当"取哪一行"依据的列。
 *
 * 两类都算：**类型是日期/时间**的，以及**名字像日期/时间**的（`STATIS_DATE`、`ORDER_DATE`、`*_DAY`）。
 * 后者是必须的 —— 很多 Oracle 表的日期是字符串存的，只看类型会漏掉。
 */
export function orderCandidateColumns<T extends { name: string; dataType?: string }>(fields: readonly T[]): T[] {
  return fields.filter((field) => {
    const type = String(field.dataType ?? "").toUpperCase();
    if (type.includes("DATE") || type.includes("TIME")) return true;
    return DATE_LIKE_NAME.test(String(field.name ?? "").trim());
  });
}

/** 生成口径时的表名：`模式.表`（模式为空就只写表名）。 */
function qualifiedName(kind: DataSourceKind, schema: string | undefined, view: string) {
  const name = view.trim();
  const container = (schema ?? "").trim();
  if (!name) throw new Error("先选一张表 / 视图，才知道口径从哪读。");
  return container ? `${quoteIdentifier(kind, container)}.${quoteIdentifier(kind, name)}` : quoteIdentifier(kind, name);
}

/**
 * 生成"按规则去重"的口径 SQL。
 *
 * 形状固定是 `SELECT * FROM (… ROW_NUMBER() … ) WHERE BKN_RN = 1`：
 * 外层 `SELECT *` 是为了让属性映射照旧按列名对上；多出来的 `BKN_RN` 不在属性里，会被忽略。
 * 列名与表名都走驱动转义（`quoteIdentifier`），所以 Oracle / PG / MySQL 通用。
 */
export function dedupeSql(input: { kind: DataSourceKind; schema?: string; view: string; rule: DedupeRule }): string {
  const table = qualifiedName(input.kind, input.schema, input.view);
  const keys = input.rule.keyColumns.map((column) => column.trim()).filter(Boolean);
  const order = input.rule.orderColumn.trim();
  if (!keys.length) throw new Error("至少要有一个分组键：一个对象对应哪几列唯一（一般就是对象主键的列）。");
  if (!order) throw new Error("要选一个取值依据列：按它取最新（或最早）的那一行，否则留哪一行是不确定的。");
  const direction = input.rule.direction === "ASC" ? "ASC" : "DESC";
  const partition = keys.map((column) => quoteIdentifier(input.kind, column)).join(", ");
  const orderBy = quoteIdentifier(input.kind, order);
  return [
    "SELECT * FROM (",
    `  SELECT t.*, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${orderBy} ${direction}) AS BKN_RN`,
    `    FROM ${table} t`,
    ") WHERE BKN_RN = 1",
  ].join("\n");
}

/** 规则的人话：「按 CUST_ID + AREA_CODE 取最新一行（依据 STATIS_DATE）」。缺项就返回空串。 */
export function describeDedupeRule(rule: DedupeRule): string {
  const keys = rule.keyColumns.map((column) => column.trim()).filter(Boolean);
  const order = rule.orderColumn.trim();
  if (!keys.length || !order) return "";
  return `按 ${keys.join(" + ")} 取${rule.direction === "ASC" ? "最早" : "最新"}一行（依据 ${order}）`;
}

/**
 * 存下来的 SQL 是不是**这条规则生成的**（还是手改过）。
 *
 * 口径允许手写 SQL，但一旦存了规则，界面就得说清"规则"和"SQL"是不是一回事 —— 否则改完规则忘了重新生成，
 * 界面上写着"按最新一天"，跑的却是另一段 SQL。不一致时报 WARN，不拦发布（手写 SQL 是合法的）。
 */
export function matchesDedupeRule(input: { kind: DataSourceKind; schema?: string; view: string; rule: DedupeRule; sql: string }): boolean {
  try {
    return dedupeSql(input).trim() === input.sql.trim();
  } catch {
    return false;
  }
}
