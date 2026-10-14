import type { OntologyDefinition } from "@/lib/ontology";
import type { LinkPlan } from "@/lib/ontology/link-source";
import type { CompareOperator, QueryDsl, SelectItem } from "./schema";

export type ResolvedSource = {
  id: string;
  alias: string;
  schema: string;
  table: string;
  primaryKey: string[];
  titleField: string;
  primary: boolean;
  /**
   * 取数口径（`kind: DERIVED` 的主来源才有）。非空时**物理表这一格是空的**，
   * 编出来是 `(口径) 别名` 这个子查询 —— 与对象服务那边的读法保持同一个口径。
   */
  sql: string;
};

export type ResolvedProperty = {
  name: string;
  dataType: string;
  sourceField: string;
  sourceId: string;
  sourceAlias: string;
  column: string;
  /** `源列` 落在哪张表上 —— 报错要补"这一列有哪些值"时，工具层拿它查列画像。 */
  sourceSchema: string;
  sourceTable: string;
  enumValues: { value: string; label: string }[];
};

export type ResolvedEntity = {
  alias: string;
  entityTypeId: string;
  entityTypeName: string;
  primarySourceId: string;
  dataSourceId: string;
  schema: string;
  table: string;
  primaryKey: string[];
  titleField: string;
  sources: ResolvedSource[];
  properties: Map<string, ResolvedProperty>;
};

export type ResolvedField = ResolvedProperty & {
  alias: string;
  entityTypeId: string;
  entityTypeName: string;
};

export type ResolvedScalar = string | number | boolean | null;
export type ResolvedValue = ResolvedScalar | { param: string } | ResolvedScalar[];

export type ResolvedFilter = {
  kind: "condition";
  field: ResolvedField;
  op: CompareOperator;
  value?: ResolvedValue;
};

export type ResolvedExpr =
  | { kind: "and" | "or"; items: ResolvedExpr[] }
  | { kind: "not"; item: ResolvedExpr }
  | ResolvedFilter;

export type ResolvedMetric = {
  id: string;
  name: string;
  description: string;
  aggregation: OntologyDefinition["metrics"][number]["aggregation"];
  property?: ResolvedField;
  filters: ResolvedFilter[];
  dimensions: ResolvedField[];
  status: OntologyDefinition["metrics"][number]["status"];
  unit: string;
};

export type ResolvedSelectItem =
  | { kind: "field"; field: ResolvedField; as: string }
  /** `LABEL(属性) AS 列名`：输出 / 分组的是中文标签，不是码值。 */
  | { kind: "label"; field: ResolvedField; as: string }
  | { kind: "metric"; metric: ResolvedMetric; as: string }
  | { kind: "aggregate"; aggregate: Extract<SelectItem, { aggregate: string }>["aggregate"]; field?: ResolvedField; on: string; as: string };

export type ResolvedRelationship = {
  alias: string;
  relationId: string;
  relationName: string;
  fromAlias: string;
  toAlias: string;
  direction: "forward" | "backward";
  optional: boolean;
  sourceEntityTypeId: string;
  targetEntityTypeId: string;
  effectiveCardinality: string;
  fromEntity: ResolvedEntity;
  toEntity: ResolvedEntity;
  plan: Extract<LinkPlan, { ok: true }>;
};

export type LogicalPlan = {
  query: QueryDsl;
  root: ResolvedEntity;
  entities: Map<string, ResolvedEntity>;
  relationships: ResolvedRelationship[];
  where?: ResolvedExpr;
  select: ResolvedSelectItem[];
  groupBy: ResolvedField[];
  warnings: string[];
};
