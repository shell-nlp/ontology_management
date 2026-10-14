export type QueryDslErrorCode =
  | "UNKNOWN_ENTITY"
  | "ENTITY_NOT_BOUND"
  | "UNKNOWN_PROPERTY"
  | "UNKNOWN_METRIC"
  | "UNKNOWN_RELATIONSHIP"
  | "RELATIONSHIP_UNSUPPORTED"
  | "SECONDARY_SOURCE_UNSUPPORTED"
  | "CROSS_SOURCE_JOIN_UNSUPPORTED"
  | "CARDINALITY_UNSAFE"
  | "METRIC_SCOPE_MISMATCH"
  | "METRIC_DIMENSION_MISMATCH"
  | "INVALID_QUERY"
  | "UNSUPPORTED_OPERATOR";

/**
 * 报错时顺带带上"要查哪一列的取值" —— 工具层拿它去列画像里捞真实取值补进错误
 * （查询层是纯的、不连库，取数留在 dispatch；见 `enrichQueryError` 与 `columnValuesHint`）。
 */
export type QueryDslValueLookup = { schema: string; table: string; column: string; propertyName: string };

export class QueryDslError extends Error {
  constructor(
    public readonly code: QueryDslErrorCode,
    message: string,
    public readonly hint = "",
    public readonly lookup: QueryDslValueLookup | null = null,
  ) {
    super(message);
    this.name = "QueryDslError";
  }
}