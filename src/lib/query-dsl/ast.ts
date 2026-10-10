import type { OntologyDefinition } from "@/lib/ontology";
import type { CompareOperator, QueryDsl, SelectItem } from "./schema";

export type ResolvedProperty = {
  name: string;
  dataType: string;
  sourceField: string;
  sourceId: string;
  column: string;
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
  | { kind: "metric"; metric: ResolvedMetric; as: string }
  | { kind: "aggregate"; aggregate: Extract<SelectItem, { aggregate: string }>["aggregate"]; field?: ResolvedField; on: string; as: string };

export type LogicalPlan = {
  query: QueryDsl;
  root: ResolvedEntity;
  where?: ResolvedExpr;
  select: ResolvedSelectItem[];
  groupBy: ResolvedField[];
  warnings: string[];
};