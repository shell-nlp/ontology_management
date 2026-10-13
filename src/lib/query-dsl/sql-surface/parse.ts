import { QueryDslError } from "../errors";

/**
 * 本体 SQL —— **SQL 形状的查询表层**（词法与语法分析）。
 *
 * 定位（2026-10-14 用户拍板）：表层写成 SQL 形状，让模型与人都能用熟的那套语法；
 * **内核仍然是本体语义** —— 这里产出的语法树交给 `bind.ts` 变成与 JSON DSL **同一份** `QueryDsl`，
 * 再走既有的 resolve → LogicalPlan → 按方言编译 → 只读执行。于是：
 *
 * - 换表层不换保证：基数 fail-closed、跨数据资源拒绝、指标口径、只读闸门一条不少；
 * - JSON DSL 与本体 SQL 是**同一个语义**的两种写法，不是两套实现。
 *
 * 只认一个**明确子集**（不支持的语法直接报错，不做静默近似）：SELECT / FROM / [LEFT] JOIN /
 * WHERE / GROUP BY / ORDER BY / LIMIT。子查询、CTE、UNION、窗口函数、任意函数都**不在**这一版里。
 * 关系遍历在 SQL 里没有对应语法，所以加了三个关键字 `FORWARD` / `BACKWARD` / `BOTH`
 * （本体关系是双向的一条定义，方向是查询时的选择）—— 这是本方言**唯一**的语法扩展。
 */

export type SqlDirection = "forward" | "backward" | "both";

export type SqlValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "param"; name: string };

/** 字段引用：`属性`（缺别名 = 根）或 `别名.属性`。 */
export type SqlFieldRef = { alias: string; property: string; explicitAlias: boolean };

export type SqlCompareOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

export type SqlCondition =
  | { kind: "compare"; field: SqlFieldRef; op: SqlCompareOp; value: SqlValue }
  | { kind: "in"; field: SqlFieldRef; values: SqlValue[]; negated: boolean }
  | { kind: "between"; field: SqlFieldRef; from: SqlValue; to: SqlValue }
  | { kind: "like"; field: SqlFieldRef; pattern: string }
  | { kind: "null"; field: SqlFieldRef; negated: boolean }
  /** `LABEL(属性) = '在用'` —— 按枚举标签比，而不是按原始值比。 */
  | { kind: "label"; field: SqlFieldRef; value: SqlValue };

export type SqlExpr =
  | { kind: "and"; items: SqlExpr[] }
  | { kind: "or"; items: SqlExpr[] }
  | { kind: "not"; item: SqlExpr }
  | SqlCondition;

export type SqlAggregate = "COUNT" | "COUNT_DISTINCT" | "SUM" | "AVG" | "MIN" | "MAX";

export type SqlSelectItem =
  /** `SELECT 属性` / `SELECT 别名.属性` —— `as` 省略时用属性名。 */
  | { kind: "field"; field: SqlFieldRef; as: string }
  /** `SELECT 客户数` —— 是属性还是指标由 `bind.ts` 拿着本体定义判定。 */
  | { kind: "name"; name: string; as: string; position: number }
  | { kind: "aggregate"; aggregate: SqlAggregate; field?: SqlFieldRef; as: string };

export type SqlJoin = {
  relation: string;
  /** 省略 = 用关系类型名当别名（确定、不依赖"另一端是什么类型"）。 */
  alias: string;
  aliasExplicit: boolean;
  direction: SqlDirection;
  /** LEFT JOIN → 可选（对不上也保留左边这一行）；JOIN → 必连。 */
  optional: boolean;
};

export type SqlQueryAst = {
  objectType: string;
  rootAlias: string;
  rootAliasExplicit: boolean;
  joins: SqlJoin[];
  select: SqlSelectItem[];
  where?: SqlExpr;
  groupBy: SqlFieldRef[];
  orderBy: { ref: string; direction: "asc" | "desc" }[];
  limit?: number;
};

type Token =
  | { kind: "ident"; value: string; quoted: boolean; at: number }
  | { kind: "string"; value: string; at: number }
  | { kind: "number"; value: number; at: number }
  | { kind: "param"; value: string; at: number }
  | { kind: "punct"; value: string; at: number }
  | { kind: "eof"; at: number };

const IDENT_CHAR = /[\p{L}\p{N}_$]/u;
const IDENT_START = /[\p{L}_$]/u;

function isDigit(char: string) {
  return char >= "0" && char <= "9";
}

/**
 * 词法分析。标识符允许中文（对象类型 / 属性名本来就是业务词），也允许 `"..."` / `` `...` `` / `[...]` 三种引号。
 * `--` 行注释与块注释也照收 —— 人与模型都可能写进来。
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const length = sql.length;
  while (index < length) {
    const char = sql[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") { index += 1; continue; }
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline < 0 ? length : newline + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      if (close < 0) throw new QueryDslError("INVALID_QUERY", "本体 SQL 解析失败：块注释没有闭合（缺 */）。");
      index = close + 2;
      continue;
    }
    if (char === "'") {
      let text = "";
      let cursor = index + 1;
      for (;;) {
        if (cursor >= length) throw new QueryDslError("INVALID_QUERY", "本体 SQL 解析失败：字符串没有闭合（缺单引号）。");
        if (sql[cursor] === "'") {
          if (sql[cursor + 1] === "'") { text += "'"; cursor += 2; continue; }
          cursor += 1;
          break;
        }
        text += sql[cursor];
        cursor += 1;
      }
      tokens.push({ kind: "string", value: text, at: index });
      index = cursor;
      continue;
    }
    if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      const end = sql.indexOf(close, index + 1);
      if (end < 0) throw new QueryDslError("INVALID_QUERY", `本体 SQL 解析失败：标识符引用没有闭合（缺 ${close}）。`);
      tokens.push({ kind: "ident", value: sql.slice(index + 1, end), quoted: true, at: index });
      index = end + 1;
      continue;
    }
    if (char === ":") {
      let cursor = index + 1;
      let name = "";
      while (cursor < length && IDENT_CHAR.test(sql[cursor])) { name += sql[cursor]; cursor += 1; }
      if (!name) throw new QueryDslError("INVALID_QUERY", "本体 SQL 解析失败：参数名不能为空（写法是 :名字，例如 :state）。");
      tokens.push({ kind: "param", value: name, at: index });
      index = cursor;
      continue;
    }
    if (isDigit(char) || (char === "." && isDigit(sql[index + 1] ?? ""))) {
      let cursor = index;
      let text = "";
      while (cursor < length && (isDigit(sql[cursor]) || sql[cursor] === ".")) { text += sql[cursor]; cursor += 1; }
      const value = Number(text);
      if (!Number.isFinite(value)) throw new QueryDslError("INVALID_QUERY", `本体 SQL 解析失败：数字「${text}」看不懂。`);
      tokens.push({ kind: "number", value, at: index });
      index = cursor;
      continue;
    }
    if (IDENT_START.test(char) || IDENT_CHAR.test(char)) {
      let cursor = index;
      let text = "";
      while (cursor < length && IDENT_CHAR.test(sql[cursor])) { text += sql[cursor]; cursor += 1; }
      tokens.push({ kind: "ident", value: text, quoted: false, at: index });
      index = cursor;
      continue;
    }
    const two = sql.slice(index, index + 2);
    if (["<=", ">=", "<>", "!="].includes(two)) { tokens.push({ kind: "punct", value: two === "!=" ? "<>" : two, at: index }); index += 2; continue; }
    if (["(", ")", ",", ".", "*", "=", "<", ">"].includes(char)) { tokens.push({ kind: "punct", value: char, at: index }); index += 1; continue; }
    throw new QueryDslError("INVALID_QUERY", `本体 SQL 解析失败：第 ${index + 1} 个字符「${char}」不是这个方言里的语法。`);
  }
  tokens.push({ kind: "eof", at: length });
  return tokens;
}

/** SQL 方言里没有"关系方向"这个概念，所以加了 FORWARD / BACKWARD / BOTH —— 这是唯一的语法扩展。 */
const KEYWORDS = new Set([
  "select", "from", "as", "join", "left", "inner", "outer", "on",
  "where", "group", "by", "order", "asc", "desc", "limit",
  "and", "or", "not", "in", "between", "is", "null", "like", "distinct",
  "true", "false", "count", "sum", "avg", "min", "max", "label",
  "forward", "backward", "both",
]);

const AGGREGATES: Record<string, SqlAggregate> = { count: "COUNT", sum: "SUM", avg: "AVG", min: "MIN", max: "MAX" };

class Parser {
  private tokens: Token[];
  private cursor = 0;
  private sql: string;

  constructor(sql: string) {
    this.sql = sql;
    this.tokens = tokenize(sql);
  }

  parse(): SqlQueryAst {
    this.expectKeyword("select");
    const select = this.parseSelectList();
    this.expectKeyword("from");
    const objectType = this.readName("对象类型名");
    let rootAlias = "root";
    let rootAliasExplicit = false;
    if (this.eatKeyword("as")) { rootAlias = this.readName("别名"); rootAliasExplicit = true; }
    else if (this.peek().kind === "ident" && !this.isKeyword(this.peek())) { rootAlias = this.readName("别名"); rootAliasExplicit = true; }

    const joins: SqlJoin[] = [];
    for (;;) {
      const optional = this.eatKeyword("left");
      if (optional) this.eatKeyword("outer");
      if (!this.eatKeyword("join")) {
        if (optional) this.fail("LEFT 后面必须是 JOIN。");
        break;
      }
      const relation = this.readName("关系类型名");
      let alias = relation;
      let aliasExplicit = false;
      if (this.eatKeyword("as")) { alias = this.readName("别名"); aliasExplicit = true; }
      else if (this.peek().kind === "ident" && !this.isKeyword(this.peek())) { alias = this.readName("别名"); aliasExplicit = true; }
      let direction: SqlDirection = "forward";
      if (this.eatKeyword("forward")) direction = "forward";
      else if (this.eatKeyword("backward")) direction = "backward";
      else if (this.eatKeyword("both")) direction = "both";
      joins.push({ relation, alias, aliasExplicit, direction, optional });
    }

    let where: SqlExpr | undefined;
    if (this.eatKeyword("where")) where = this.parseExpr();

    const groupBy: SqlFieldRef[] = [];
    if (this.eatKeyword("group")) {
      this.expectKeyword("by");
      do { groupBy.push(this.parseFieldRef()); } while (this.eatPunct(","));
    }

    const orderBy: { ref: string; direction: "asc" | "desc" }[] = [];
    if (this.eatKeyword("order")) {
      this.expectKeyword("by");
      for (;;) {
        const ref = this.readOrderRef();
        let direction: "asc" | "desc" = "asc";
        if (this.eatKeyword("asc")) direction = "asc";
        else if (this.eatKeyword("desc")) direction = "desc";
        orderBy.push({ ref, direction });
        if (!this.eatPunct(",")) break;
      }
    }

    let limit: number | undefined;
    if (this.eatKeyword("limit")) {
      const token = this.peek();
      if (token.kind !== "number" || !Number.isInteger(token.value) || token.value < 1) this.fail("LIMIT 后面要跟一个正整数。");
      limit = token.value;
      this.cursor += 1;
    }

    const rest = this.peek();
    if (rest.kind !== "eof") this.fail(`只支持 SELECT / FROM / JOIN / WHERE / GROUP BY / ORDER BY / LIMIT，这里多出来「${this.tokenText(rest)}」。`);
    if (!select.length) this.fail("SELECT 里至少要写一个字段、指标或聚合。");
    return { objectType, rootAlias, rootAliasExplicit, joins, select, where, groupBy, orderBy, limit };
  }

  private parseSelectList(): SqlSelectItem[] {
    const items: SqlSelectItem[] = [];
    do {
      items.push(this.parseSelectItem(items.length));
    } while (this.eatPunct(","));
    return items;
  }

  private parseSelectItem(position: number): SqlSelectItem {
    const token = this.peek();
    if (token.kind === "punct" && token.value === "*") {
      this.fail("SELECT * 不接受：要全部属性就把属性名列出来，要计数就写 COUNT(*)。");
    }
    if (token.kind === "ident" && !token.quoted && AGGREGATES[token.value.toLowerCase()] && this.peekAt(1).kind === "punct" && (this.peekAt(1) as { value: string }).value === "(") {
      this.cursor += 1;
      this.cursor += 1; // (
      let aggregate = AGGREGATES[token.value.toLowerCase()];
      let field: SqlFieldRef | undefined;
      if (aggregate === "COUNT" && this.eatKeyword("distinct")) aggregate = "COUNT_DISTINCT";
      if (this.eatPunct("*")) {
        if (aggregate !== "COUNT") this.fail(`${token.value.toUpperCase()}(*) 只有 COUNT 能用。`);
      } else {
        field = this.parseFieldRef();
      }
      this.expectPunct(")");
      return { kind: "aggregate", aggregate, field, as: this.readAs(`${aggregate.toLowerCase()}`) };
    }
    if (token.kind === "ident" && !token.quoted && token.value.toLowerCase() === "label") {
      this.fail("LABEL(...) 只能写在 WHERE 里（按枚举标签过滤），不能作为输出列。");
    }
    // `别名.属性` 还是 `属性`：先按字段引用解析，再回看它带没带别名。
    const field = this.parseFieldRef();
    const as = this.readAs(field.property);
    if (!field.explicitAlias) return { kind: "name", name: field.property, as, position };
    return { kind: "field", field, as };
  }

  private readAs(fallback: string): string {
    if (this.eatKeyword("as")) return this.readName("输出列名");
    return fallback;
  }

  private parseFieldRef(): SqlFieldRef {
    const first = this.readName("属性名");
    if (this.eatPunct(".")) {
      const property = this.readName("属性名");
      return { alias: first, property, explicitAlias: true };
    }
    return { alias: "root", property: first, explicitAlias: false };
  }

  private parseExpr(): SqlExpr {
    const items = [this.parseAnd()];
    while (this.eatKeyword("or")) items.push(this.parseAnd());
    return items.length === 1 ? items[0] : { kind: "or", items };
  }

  private parseAnd(): SqlExpr {
    const items = [this.parseNot()];
    while (this.eatKeyword("and")) items.push(this.parseNot());
    return items.length === 1 ? items[0] : { kind: "and", items };
  }

  private parseNot(): SqlExpr {
    if (this.eatKeyword("not")) return { kind: "not", item: this.parseNot() };
    if (this.eatPunct("(")) {
      const inner = this.parseExpr();
      this.expectPunct(")");
      return inner;
    }
    return this.parseCondition();
  }

  private parseCondition(): SqlExpr {
    // LABEL(属性) = '标签'
    if (this.peekKeyword("label")) {
      this.cursor += 1;
      this.expectPunct("(");
      const field = this.parseFieldRef();
      this.expectPunct(")");
      const punct = this.peek();
      if (punct.kind !== "punct" || punct.value !== "=") this.fail("LABEL(...) 只支持 = 比较；要取反就写 NOT (LABEL(...) = '...')。");
      this.cursor += 1;
      return { kind: "label", field, value: this.parseValue() };
    }
    const field = this.parseFieldRef();
    const token = this.peek();
    if (token.kind === "ident" && !token.quoted) {
      const word = token.value.toLowerCase();
      if (word === "is") {
        this.cursor += 1;
        const negated = this.eatKeyword("not");
        this.expectKeyword("null");
        return { kind: "null", field, negated };
      }
      if (word === "in") {
        this.cursor += 1;
        this.expectPunct("(");
        const values: SqlValue[] = [];
        do { values.push(this.parseValue()); } while (this.eatPunct(","));
        this.expectPunct(")");
        if (!values.length) this.fail("IN 后面至少要有一个值。");
        return { kind: "in", field, values, negated: false };
      }
      if (word === "between") {
        this.cursor += 1;
        const from = this.parseValue();
        this.expectKeyword("and");
        const to = this.parseValue();
        return { kind: "between", field, from, to };
      }
      if (word === "like") {
        this.cursor += 1;
        const pattern = this.parseValue();
        if (pattern.kind !== "string") this.fail("LIKE 后面要跟一个字符串模式（例如 '%郑州%'）。");
        return { kind: "like", field, pattern: pattern.value };
      }
      if (word === "not") {
        // NOT IN / NOT LIKE / NOT BETWEEN
        this.cursor += 1;
        if (this.eatKeyword("in")) {
          this.expectPunct("(");
          const values: SqlValue[] = [];
          do { values.push(this.parseValue()); } while (this.eatPunct(","));
          this.expectPunct(")");
          return { kind: "in", field, values, negated: true };
        }
        if (this.eatKeyword("like")) {
          const pattern = this.parseValue();
          if (pattern.kind !== "string") this.fail("LIKE 后面要跟一个字符串模式。");
          return { kind: "not", item: { kind: "like", field, pattern: pattern.value } };
        }
        if (this.eatKeyword("between")) {
          const from = this.parseValue();
          this.expectKeyword("and");
          const to = this.parseValue();
          return { kind: "not", item: { kind: "between", field, from, to } };
        }
        this.fail("NOT 后面只支持 IN / LIKE / BETWEEN / NULL。");
      }
    }
    if (token.kind !== "punct") this.fail(`「${field.property}」后面要跟比较运算符（= <> > >= < <= IN BETWEEN IS NULL LIKE）。`);
    const op: SqlCompareOp = token.value === "=" ? "eq" : token.value === "<>" ? "ne" : token.value === ">" ? "gt" : token.value === ">=" ? "gte" : token.value === "<" ? "lt" : token.value === "<=" ? "lte" : (this.fail(`不认识的比较运算符「${token.value}」。`) as never);
    this.cursor += 1;
    return { kind: "compare", field, op, value: this.parseValue() };
  }

  private parseValue(): SqlValue {
    const token = this.peek();
    if (token.kind === "string") { this.cursor += 1; return { kind: "string", value: token.value }; }
    if (token.kind === "number") { this.cursor += 1; return { kind: "number", value: token.value }; }
    if (token.kind === "param") { this.cursor += 1; return { kind: "param", name: token.value }; }
    if (token.kind === "ident" && !token.quoted) {
      const word = token.value.toLowerCase();
      if (word === "true") { this.cursor += 1; return { kind: "boolean", value: true }; }
      if (word === "false") { this.cursor += 1; return { kind: "boolean", value: false }; }
      if (word === "null") { this.cursor += 1; return { kind: "null" }; }
    }
    this.fail(`这里要一个值（字符串、数字、TRUE / FALSE / NULL，或参数 :名字），拿到的是「${this.tokenText(token)}」。`);
  }

  /** ORDER BY 的引用既可能是输出列名，也可能是属性 —— 两种都收，交给 `bind.ts` 判。 */
  private readOrderRef(): string {
    const token = this.peek();
    if (token.kind === "string") { this.cursor += 1; return token.value; }
    const field = this.parseFieldRef();
    return field.explicitAlias ? `${field.alias}.${field.property}` : field.property;
  }

  private readName(what: string): string {
    const token = this.peek();
    if (token.kind !== "ident") this.fail(`这里要${what}，拿到的是「${this.tokenText(token)}」。`);
    this.cursor += 1;
    return token.value;
  }

  private isKeyword(token: Token) {
    return token.kind === "ident" && !token.quoted && KEYWORDS.has(token.value.toLowerCase());
  }

  private peekKeyword(word: string) {
    return this.isKeyword(this.peek()) && this.peek().kind === "ident" && (this.peek() as { value: string }).value.toLowerCase() === word;
  }

  private peek() { return this.tokens[Math.min(this.cursor, this.tokens.length - 1)]; }
  private peekAt(offset: number) { return this.tokens[Math.min(this.cursor + offset, this.tokens.length - 1)]; }
  private tokenText(token: Token) {
    if (token.kind === "eof") return "结尾";
    if (token.kind === "punct") return token.value;
    if (token.kind === "param") return `:${token.value}`;
    return String(token.value);
  }

  private eatKeyword(word: string) {
    if (this.peekKeyword(word)) { this.cursor += 1; return true; }
    return false;
  }

  private expectKeyword(word: string) {
    if (!this.eatKeyword(word)) this.fail(`这里要关键字 ${word.toUpperCase()}，拿到的是「${this.tokenText(this.peek())}」。`);
  }

  private eatPunct(value: string) {
    const token = this.peek();
    if (token.kind === "punct" && token.value === value) { this.cursor += 1; return true; }
    return false;
  }

  private expectPunct(value: string) {
    if (!this.eatPunct(value)) this.fail(`这里要「${value}」，拿到的是「${this.tokenText(this.peek())}」。`);
  }

  private fail(message: string): never {
    const token = this.peek();
    const at = token.kind === "eof" ? "末尾" : `第 ${token.at + 1} 个字符附近`;
    throw new QueryDslError("INVALID_QUERY", `本体 SQL 解析失败（${at}）：${message}`);
  }
}

/** 文本 → 语法树。语义（拿本体判断"这是属性还是指标"）在 `bind.ts` 里做。 */
export function parseOntologySql(sql: string): SqlQueryAst {
  const text = String(sql ?? "").trim();
  if (!text) throw new QueryDslError("INVALID_QUERY", "本体 SQL 不能为空。");
  return new Parser(text).parse();
}
