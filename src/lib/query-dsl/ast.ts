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
};

export type ResolvedProperty = {
  name: string;
  dataType: string;
  sourceField: string;
  sourceId: string;
  sourceAlias: string;
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