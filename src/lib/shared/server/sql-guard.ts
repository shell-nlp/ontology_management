import type { DataSourceKind, DataSourceRowFilter } from "@/lib/shared/common/data-source-kind";
import { quoteIdentifier } from "@/lib/shared/server/sql-object-name";

const DATA_SOURCE_KIND_LABELS: Record<DataSourceKind, string> = {
  POSTGRES: "PostgreSQL",
  MYSQL: "MySQL",
  ORACLE: "Oracle",
};

/**
 * 只读 SQL 的闸门。**纯函数，服务端与测试都用这一份**。
 *
 * 这里只做词法判断（语句长得像不像查询），真正的最后一道闸在数据库那边：
 * 查询被包在只读事务里执行，DML / DDL 会被库里直接拒掉（见 sql.ts 的 runReadOnlyQuery）。
 * 两道闸是有意重复的 —— 词法这层给出「为什么被拒」的清楚说法，库那层兜住词法漏掉的写法。
 *
 * 取值取向：**宁可偶尔误杀**（模型换个写法重来一次），也不要放过一次写操作。
 */

/** 允许开头的动词。写操作没有一条能过这一关。 */
export const READ_ONLY_PREFIXES = ["SELECT", "WITH", "SHOW", "DESC", "DESCRIBE", "EXPLAIN", "VALUES", "TABLE"];

/**
 * 即使在只读语句里也不放行的词：改数据、改结构、改权限、事务控制、以及会落地的
 * SELECT ... INTO / INTO OUTFILE。刻意**不含** UPDATE / DELETE / COMMENT / USER 这类
 * 常见列名的词 —— 有那一层只读事务兜底，不必为了它们把正常查询也误杀。
 */
export const FORBIDDEN_KEYWORDS = [
  "INSERT", "MERGE", "UPSERT", "TRUNCATE", "DROP", "ALTER", "CREATE", "RENAME",
  "GRANT", "REVOKE", "CALL", "EXEC", "EXECUTE", "COMMIT", "ROLLBACK", "SAVEPOINT",
  "LOCK", "UNLOCK", "INTO", "OUTFILE", "DUMPFILE", "COPY", "VACUUM", "REINDEX",
  "ATTACH", "DETACH", "SHUTDOWN", "KILL", "PURGE",
];

/**
 * 去掉注释与字符串字面量，只留下"语句骨架"。
 *
 * 不该被当成语义的地方不能被当成语义：`SELECT '删库'` 里的中文、`-- DROP TABLE` 这类注释
 * 都不该触发拦截；反过来，用块注释把写操作包起来藏进去，拼回骨架之后照样会被看见。
 * 字符串字面量换成一对空引号，保留语句形状（`SELECT '' FROM t`）。
 */
export function stripSqlNoise(sql: string): string {
  let out = "";
  for (let index = 0; index < sql.length; index += 1) {
    const ch = sql[index];
    const next = sql[index + 1];
    if (ch === "-" && next === "-") {
      // 连换行一起吃掉，再补一个空格：不能让上下两行粘成一个词。
      while (index < sql.length && sql[index] !== "\n") index += 1;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 1;
      out += " ";
      continue;
    }
    if (ch === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") { index += 2; continue; }
        if (sql[index] === "'") break;
        index += 1;
      }
      out += "''";
      continue;
    }
    out += ch;
  }
  return out;
}

/** 语句开头的动词，形如 `SELECT` / `WITH` / `EXPLAIN`；空语句给空串。 */
export function leadingKeyword(statement: string): string {
  return /^[A-Za-z]+/.exec(statement.trim())?.[0]?.toUpperCase() ?? "";
}

/**
 * 校验一条 SQL 只能是只读查询，通过后返回去掉尾分号的语句。
 * 不通过就抛错 —— 错误信息是给模型看的，要说清"哪一条规则没过"。
 */
export function assertReadOnlySql(sql: string, subject = "这个工具"): string {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error("SQL 不能为空。");

  const bare = stripSqlNoise(trimmed);
  const statements = bare.split(";").map((part) => part.trim()).filter(Boolean);
  if (statements.length === 0) throw new Error("SQL 不能为空。");
  if (statements.length > 1) throw new Error("一次只能执行一条语句：检测到多条（用分号分隔）。");

  const statement = statements[0];
  const leading = leadingKeyword(statement);
  if (!READ_ONLY_PREFIXES.includes(leading)) {
    throw new Error(`${subject}只能执行只读查询：语句必须以 ${READ_ONLY_PREFIXES.join(" / ")} 开头，收到的是「${leading || "空"}」。`);
  }

  const upper = statement.toUpperCase();
  const hit = FORBIDDEN_KEYWORDS.find((keyword) => new RegExp(`\\b${keyword}\\b`).test(upper));
  if (hit) {
    throw new Error(`${subject}只能执行只读查询：语句里出现了「${hit}」，被拦下了。查询请去掉它再试。`);
  }
  return trimmed.replace(/;\s*$/, "");
}

/**
 * 给语句套一层行数上限。只有 SELECT / WITH / VALUES / TABLE 能套（SHOW / EXPLAIN 套不了，
 * 原样执行，由驱动侧截断）；Oracle 没有 LIMIT，用 ROWNUM 包一层。
 */
export function boundedStatement(kind: DataSourceKind, statement: string, limit: number) {
  // 比 SQL_ROWS_CEILING 多留一行：调用方为了判"有没有被截断"会多要一行探针（见 takeRows）。
  // 不留这一行的话，请求正好打在上限时永远查不出第 5001 行，截断标记就会漏报。
  const rows = Math.min(Math.max(1, Math.floor(limit)), SQL_ROWS_CEILING + 1);
  const leading = leadingKeyword(statement);
  if (!["SELECT", "WITH", "VALUES", "TABLE"].includes(leading)) return statement;
  return kind === "ORACLE"
    ? `SELECT * FROM (${statement}) WHERE ROWNUM <= ${rows}`
    : `SELECT * FROM (${statement}) AS bkn_query LIMIT ${rows}`;
}

/** LIKE 里的 % 与 _ 是通配符：用户输入的它们应当按字面匹配。 */
export function escapeLikePattern(value: string) {
  return value.replace(/([\\%_])/g, "\\$1");
}

/**
 * 把**取数口径**（一段只读 SQL）当子查询时，外面这层要的取行条件。
 * 只覆盖对象服务真正会下推的算子（EQ / NE / CONTAINS / IN）+ 主键游标翻页。
 */
export type DerivedQuery = {
  columns?: readonly string[];
  filters?: readonly DataSourceRowFilter[];
  orderBy?: readonly string[];
  after?: readonly unknown[];
  offset?: number;
};

/** 三种库的占位符：PG `$n`、MySQL `?`、Oracle `:n`。参数**按出现顺序** push，顺序即编号。 */
function placeholders(kind: DataSourceKind, params: unknown[]) {
  return (value: unknown) => {
    params.push(value);
    const position = params.length;
    if (kind === "POSTGRES") return `$${position}`;
    if (kind === "MYSQL") return "?";
    return `:${position}`;
  };
}

/** Oracle 的绑定是「按位置、名字是数字」的对象（与对象服务里既有的写法一致）。 */
function oracleBinds(kind: DataSourceKind, params: unknown[]) {
  return kind === "ORACLE" ? Object.fromEntries(params.map((value, index) => [String(index + 1), value])) : params;
}

function derivedConditions(
  kind: DataSourceKind,
  query: Pick<DerivedQuery, "filters" | "orderBy" | "after">,
  alias: string,
  params: unknown[],
): string[] {
  const place = placeholders(kind, params);
  const column = (name: string) => `${alias}.${quoteIdentifier(kind, name)}`;
  const conditions: string[] = [];
  for (const filter of query.filters ?? []) {
    const name = String(filter.column ?? "").trim();
    if (!name) continue;
    const reference = column(name);
    if (filter.operator === "IN") {
      const values = (Array.isArray(filter.value) ? filter.value : [filter.value])
        .filter((item) => item !== null && item !== undefined)
        .slice(0, 200);
      if (!values.length) { conditions.push("1 = 0"); continue; }
      conditions.push(`${reference} IN (${values.map((value) => place(value)).join(", ")})`);
      continue;
    }
    if (filter.operator === "CONTAINS") {
      conditions.push(`${reference} LIKE ${place(`%${escapeLikePattern(String(filter.value ?? ""))}%`)} ESCAPE '\\'`);
      continue;
    }
    conditions.push(`${reference} ${filter.operator === "NE" ? "<>" : "="} ${place(filter.value)}`);
  }
  /*
   * 键集（游标）翻页：`(k0 > :1) OR (k0 = :2 AND k1 > :3) …`；与结构化取行**同一语义**。
   * 差别只有一处：那边用具名参数，同一个值可以复用；这里的位置占位符不能复用，
   * 所以 after 的值会按出现的次数各绑一次 —— 语义相同，别当成 bug。
   */
  const orderColumns = (query.orderBy ?? []).map((name) => name.trim()).filter(Boolean);
  const after = query.after ?? [];
  if (orderColumns.length && after.length === orderColumns.length) {
    const parts = orderColumns.map((name, position) => {
      const equalities = orderColumns.slice(0, position).map((earlier, index) => `${column(earlier)} = ${place(after[index])}`);
      return [...equalities, `${column(name)} > ${place(after[position])}`].join(" AND ");
    });
    conditions.push(`(${parts.join(" OR ")})`);
  }
  return conditions;
}

/**
 * **取数口径当来源**时构造取行语句（纯函数，可单测）。
 *
 * 为什么不用 QueryBuilder：TypeORM 的 `.from()` 会把传进去的字符串当成**标识符**加引号
 * （实测渲染成 `FROM "(SELECT …)"`），子查询过不去 —— 所以这一段自己拼。守两条：
 * 列名一律走 `quoteIdentifier`（驱动转义），值一律走**绑定参数**。
 *
 * `skip` 是给调用方的：Oracle 没有 OFFSET，只能用 `ROWNUM <= n + skip` 把前面的行也读出来，
 * 由调用方在内存里丢掉（与对象服务里既有的 Oracle 翻页口径一致）。
 */
export function derivedRowsStatement(
  kind: DataSourceKind,
  derivedSql: string,
  query: DerivedQuery,
  limit: number,
): { statement: string; params: unknown[] | Record<string, unknown>; skip: number } {
  const sql = assertReadOnlySql(derivedSql, "取数口径");
  const alias = quoteIdentifier(kind, "t");
  const params: unknown[] = [];
  const conditions = derivedConditions(kind, query, alias, params);
  const columns = (query.columns ?? []).map((name) => name.trim()).filter(Boolean);
  const projection = columns.length
    ? columns.map((name) => `${alias}.${quoteIdentifier(kind, name)}`).join(", ")
    : `${alias}.*`;
  const orderColumns = (query.orderBy ?? []).map((name) => name.trim()).filter(Boolean);
  const order = orderColumns.length
    ? ` ORDER BY ${orderColumns.map((name) => `${alias}.${quoteIdentifier(kind, name)} ASC`).join(", ")}`
    : "";
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = Math.max(1, Math.floor(limit));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const inner = `SELECT ${projection} FROM (${sql}) ${alias}${where}${order}`;
  if (kind === "ORACLE") {
    return { statement: `SELECT * FROM (${inner}) WHERE ROWNUM <= ${rows + offset}`, params: oracleBinds(kind, params), skip: offset };
  }
  return { statement: `${inner} LIMIT ${rows} OFFSET ${offset}`, params: oracleBinds(kind, params), skip: 0 };
}

/** 取数口径当来源时的总数统计：`COUNT(*)`，条件与取行同一套。 */
export function derivedCountStatement(
  kind: DataSourceKind,
  derivedSql: string,
  query: Pick<DerivedQuery, "filters">,
): { statement: string; params: unknown[] | Record<string, unknown> } {
  const sql = assertReadOnlySql(derivedSql, "取数口径");
  const alias = quoteIdentifier(kind, "t");
  const params: unknown[] = [];
  const conditions = derivedConditions(kind, query, alias, params);
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  return { statement: `SELECT COUNT(*) FROM (${sql}) ${alias}${where}`, params: oracleBinds(kind, params) };
}

/**
 * 只读查询一次最多取多少行。**全链路就这一个数**：工具层 `SQL_ROW_CEILING`、
 * 连接器 `QUERY_LIMIT_MAX`、「问答配置」里 `sqlRowLimit` 的上界都对齐到它，
 * 免得出现"界面上能填 5000、实际只给 500"这种对不上的情况。
 */
export const SQL_ROWS_CEILING = 5000;

/**
 * 把"可能多取一行"的结果切成「要返回的行 + 是否还有剩下的」。
 *
 * 为什么调用方要多取一行：给语句套上 `LIMIT n` 之后就**永远查不出超过 n 行**，
 * 于是"结果被截断了吗"这个判断会永远是假。所以连接器按 `n + 1` 去查，
 * 拿到 n + 1 行就说明还有更多 —— 这一行不返回给模型，只用来打 `truncated` 标记。
 */
export function takeRows<T>(list: readonly T[], limit: number) {
  const size = Math.max(0, Math.floor(limit));
  return { rows: list.slice(0, size), truncated: list.length > size };
}

/** 只读事务怎么开：三种库各是各的标准写法。 */
export function beginReadOnlyStatement(kind: DataSourceKind) {
  if (kind === "ORACLE") return "SET TRANSACTION READ ONLY";
  if (kind === "MYSQL") return "START TRANSACTION READ ONLY";
  return "BEGIN READ ONLY";
}

/**
 * 语句超时，尽力而为：PostgreSQL 用事务内的 SET LOCAL，MySQL 用会话参数
 * （MariaDB / 旧版不认，失败就算了）；Oracle 这一层没有等价开关，不硬凑。
 */
export function statementTimeoutStatements(kind: DataSourceKind, timeoutMs: number) {
  const ms = Math.max(1000, Math.floor(timeoutMs));
  if (kind === "POSTGRES") return { before: [] as string[], inside: [`SET LOCAL statement_timeout = ${ms}`] };
  if (kind === "MYSQL") return { before: [`SET SESSION MAX_EXECUTION_TIME = ${ms}`], inside: [] as string[] };
  return { before: [] as string[], inside: [] as string[] };
}

/** 一行说明"这条语句被允许到什么程度"，跟着查询结果一起给模型，省得它去猜。 */
export function readOnlyPolicyNote(kind: DataSourceKind) {
  return `只读查询：语句必须以 ${READ_ONLY_PREFIXES.join(" / ")} 开头，且不能含写操作关键字；执行时还会包在 ${DATA_SOURCE_KIND_LABELS[kind]} 的只读事务里。`;
}
