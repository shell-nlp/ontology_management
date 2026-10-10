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

export class QueryDslError extends Error {
  constructor(
    public readonly code: QueryDslErrorCode,
    message: string,
    public readonly hint = "",
  ) {
    super(message);
    this.name = "QueryDslError";
  }
}