import { localName } from "./protocol";

export const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

export const RDFS = "http://www.w3.org/2000/01/rdf-schema#";

export const OWL = "http://www.w3.org/2002/07/owl#";

export const RDF_TYPE = `${RDF}type`;

export const RDFS_LABEL = `${RDFS}label`;

export const RDFS_SUBCLASS = `${RDFS}subClassOf`;

export const RDFS_DOMAIN = `${RDFS}domain`;

export const RDFS_RANGE = `${RDFS}range`;

export const RDF_FIRST = `${RDF}first`;

export const RDF_REST = `${RDF}rest`;

export const OWL_CLASS = `${OWL}Class`;

export const RDFS_CLASS = `${RDFS}Class`;

export const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`;

export const RDF_PROPERTY = `${RDF}Property`;

export const OWL_SAME_AS = `${OWL}sameAs`;

export const BKN = "urn:bkn:";

/** 平台自己的谓词：区分「接口实现」与「接口继承」（两者都写 rdfs:subClassOf）。 */
export const BKN_IMPLEMENTS = `${BKN}implements`;

export const BKN_RELATIONSHIP = `${BKN}Relationship`;

export const BKN_REL_TYPE = `${BKN}relType`;

export const BKN_SOURCE = `${BKN}source`;

export const BKN_TARGET = `${BKN}target`;

export const BKN_NODE_PREFIX = `${BKN}node:`;

export const BKN_CLASS_PREFIX = `${BKN}class:`;

export const BKN_PROPERTY_PREFIX = `${BKN}prop:`;

export const BKN_RELATIONSHIP_PREFIX = `${BKN}rel:`;

export const BKN_REL_TYPE_PREFIX = `${BKN}reltype:`;

/** 结构谓词只在内部使用，不作为节点属性或关系暴露。 */
export const STRUCTURAL_PREDICATES = [
  RDF_TYPE,
  RDF_FIRST,
  RDF_REST,
  RDFS_SUBCLASS,
  BKN_IMPLEMENTS,
  RDFS_DOMAIN,
  RDFS_RANGE,
  OWL_SAME_AS,
  BKN_REL_TYPE,
  BKN_SOURCE,
  BKN_TARGET,
];

export const STRUCTURAL_FILTER = STRUCTURAL_PREDICATES.map((predicate) => `<${predicate}>`).join(", ");

export const STRUCTURAL_LOCAL_NAMES = STRUCTURAL_PREDICATES.map((predicate) => localName(predicate));

/**
 * 平台自己的元模型标记。
 *
 * 发布时会声明每个类与每个关系类型。声明用的主语（`urn:bkn:class:指标`）本身也是
 * RDF 资源，如果不加标记，它们会被实例查询当成对象，污染对象数、对象类型分布与导出。
 * 所以声明时同时写一条自有类型，实例读路径统一用它把元模型排除掉：
 * `owl:Class` 给外部工具看，`urn:bkn:Class` 给平台自己过滤用。
 */
export const BKN_CLASS_META = `${BKN}Class`;

/** 接口：抽象契约，不是可实例化的对象类型；实例查询必须把它一起排除掉。 */
export const BKN_INTERFACE_META = `${BKN}Interface`;

export const BKN_PROPERTY_META = `${BKN}Property`;

export const META_TYPES = [BKN_RELATIONSHIP, OWL_CLASS, RDFS_CLASS, OWL_OBJECT_PROPERTY, RDF_PROPERTY, BKN_CLASS_META, BKN_PROPERTY_META, BKN_INTERFACE_META];

export const META_TYPE_IRIS = META_TYPES.map((type) => `<${type}>`).join(", ");

/** 「?s 不是元模型资源」：加在所有以 ?s 为主语的实例级查询上。 */
export const NOT_META_SUBJECT = `FILTER NOT EXISTS { ?s <${RDF_TYPE}> ?metaType FILTER(?metaType IN (${META_TYPE_IRIS})) }`;

export type SparqlTerm = { type: string; value: string; datatype?: string; "xml:lang"?: string };

export type SparqlEndpoints = { query: string; update: string; dataset: string; namedGraph: string | null };

export type NtTerm = { value: string; type: "uri" | "bnode" | "literal"; datatype?: string; end: number };
