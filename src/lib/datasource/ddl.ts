import { qualifiedName, quoteIdentifier, quoteLiteral } from "@/lib/datasource/object-name";
import type { DataSourceKind, DataViewField, DataViewKind } from "@/lib/datasource/types";

/**
 * 表结构（DDL）的渲染：**只做从列元数据还原这一条路**的格式化，不连库、不查库。
 *
 * 单独一个文件（而不是留在 sql.ts 里）有两个原因：
 * 1. sql.ts 顶层就把 TypeORM 拉进来，纯字符串拼接的规则留在那儿就没法便宜地单测；
 * 2. 这段格式规则是要反复调的（就是它决定模型看到多少 token），得能一眼看到全貌。
 *
 * 库里自带的原始 DDL（MySQL 的 SHOW CREATE TABLE、Oracle 的 DBMS_METADATA.GET_DDL）不走这里，
 * 那是库自己的语句，原样透出。
 */

/** 长度只对字符 / 二进制族补：`DATE` 的 data_length 是 7 字节，照抄会写出不存在的 `DATE(7)`。 */
const SIZED_TYPES = /^(VARCHAR2?|NVARCHAR2?|CHAR|NCHAR|RAW|BINARY|VARBINARY|CHARACTER|CHARACTER VARYING)$/i;
/** 精度只对数值族补。 */
const PRECISION_TYPES = /^(NUMBER|NUMERIC|DECIMAL|DEC|FLOAT)$/i;

function positiveInt(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : String(value ?? "").replace(/[^\d]/g, "");
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 列的完整类型（带长度 / 精度）。
 *
 * 数据字典给的基类型常常不带括号（Oracle 的 `VARCHAR2`、`NUMBER` 都是裸名），长度与精度在另外的
 * 字段里。不带长度的 `VARCHAR2` 让模型没法判断这一列能放多少字，所以能拼就拼上。
 *
 * **只对认得出的类型补**：`DATE` 的 data_length 是 7（字节），硬拼就是 `DATE(7)` 这种不存在的类型，
 * 所以长度只给字符 / 二进制族、精度只给数值族；认不出就原样返回，不编。已经带括号的（`TIMESTAMP(6)`）
 * 一律不动 —— 那本身就已经是完整类型。
 */
export function typeWithSize(baseType: string, size: { length?: unknown; precision?: unknown; scale?: unknown } = {}) {
  const type = (baseType ?? "").trim();
  if (!type || type.includes("(")) return type;
  const precision = positiveInt(size.precision);
  if (PRECISION_TYPES.test(type) && precision) {
    const scale = positiveInt(size.scale);
    return `${type}(${precision}${scale ? `,${scale}` : ""})`;
  }
  const length = positiveInt(size.length);
  if (SIZED_TYPES.test(type) && length) return `${type}(${length})`;
  return type;
}

/**
 * 内联注释的正文。注释块结束标记会**提前把注释块收掉**（后面的列定义就掉出注释变成语法垃圾），
 * 换行会把一条列定义拆成两行，所以两个都得先处理掉再拼进列定义。
 */
export function inlineDdlComment(comment: string) {
  return comment.replace(/\*\//g, "* /").replace(/\s+/g, " ").trim();
}

/** 列的写法：类型优先用带长度的那份，取不到才退回裸类型。 */
function columnTypeText(column: DataViewField) {
  return column.typeDetail || column.dataType || "TEXT";
}

/** 列注释的写法：MySQL 天生是列尾 `COMMENT '…'`；Oracle / PG 内联成注释块，不再另发 COMMENT ON。 */
function columnCommentText(kind: DataSourceKind, column: DataViewField) {
  if (!column.comment) return "";
  return kind === "MYSQL" ? `COMMENT ${quoteLiteral(column.comment)}` : `/* ${inlineDdlComment(column.comment)} */`;
}

/**
 * 按列元数据还原一份表结构（DDL），注释**内联在列定义后面**。
 *
 * 以前 Oracle / PG 回的是两份：「CREATE TABLE」+ 每条列一个 COMMENT ON COLUMN。实测一张 36 列的表，
 * 整段 3,949 字符里 3,053 是 COMMENT ON，而真正的注释正文只有 304 —— 每条 73 字符全是重复的
 * 「模式.表.列」前缀，纯烧 token（对比 deepclaw 的 nl2sql DDL 输出格式，见 docs/功能实现记录.md）。
 * 视图还原不出 SELECT 定义（那不在列元数据里），就老实把列清单列成注释，别编一个假的 CREATE VIEW。
 */
export function ddlFromColumns(kind: DataSourceKind, schema: string, name: string, objectKind: DataViewKind, columns: DataViewField[]) {
  const target = qualifiedName(kind, schema, name);
  const render = (column: DataViewField) => `${quoteIdentifier(kind, column.name)} ${columnTypeText(column)}`;
  if (objectKind === "view") {
    return [
      `-- 视图 ${target}：下面是它对外暴露的列。`,
      "-- 视图的 SELECT 定义不在列元数据里，用数据库自带的工具看（或这个数据源上改用能取到原始 DDL 的库）。",
      ...columns.map((column) => {
        const comment = columnCommentText(kind, column);
        return `--   ${render(column)}${column.nullable ? "" : " NOT NULL"}${comment ? ` ${comment}` : ""}`;
      }),
    ].join("\n");
  }

  const lines = columns.map((column) => {
    const parts = [`  ${render(column)}`];
    if (!column.nullable) parts.push("NOT NULL");
    const comment = columnCommentText(kind, column);
    if (comment) parts.push(comment);
    return parts.join(" ");
  });
  const primary = columns.filter((column) => column.primaryKey).map((column) => quoteIdentifier(kind, column.name));
  if (primary.length) lines.push(`  PRIMARY KEY (${primary.join(", ")})`);

  return `CREATE TABLE ${target} (\n${lines.join(",\n")}\n);`;
}
