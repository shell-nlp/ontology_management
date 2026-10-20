import { PlatformSchema0001 } from "./0001-platform-schema";
import { AuditVersionColumn0002 } from "./0002-audit-version-column";
import { ColumnProfiles0003 } from "./0003-column-profiles";
import { RbacRolesAndPermissions0004 } from "./0004-rbac-roles-and-permissions";
import { OntologyVersionsAndConcepts0005 } from "./0005-ontology-versions";
import { TableAndColumnComments0006 } from "./0006-table-and-column-comments";
import { DropObjectEntries0007 } from "./0007-drop-object-entries";
import { MaterializationJobs0008 } from "./0008-materialization-jobs";
import { MaterializationJobKind0009 } from "./0009-materialization-job-kind";
import { OrphanTargetCleanup0010 } from "./0010-orphan-target-cleanup";
import { OAuthTables0011 } from "./0011-oauth";
import { MaterializeJobCursor0012 } from "./0012-materialize-job-cursor";
import { ListMetricsDefaultOpen0013 } from "./0013-list-metrics-default-open";
import { OdsTables0014 } from "./0014-ods";
import { OdsReconcile0015 } from "./0015-ods-reconcile";
import { InstanceHistory0016 } from "./0016-instance-history";
import { DropLegacyObjectMaterialization0017 } from "./0017-drop-legacy-object-materialization";

/**
 * 平台库迁移清单：**按数组顺序执行，每支都必须幂等**。
 * 新增结构改动 = 追加一支迁移类，不要在业务代码里写 DDL。
 */
export const PLATFORM_MIGRATIONS = [
  new PlatformSchema0001(),
  new AuditVersionColumn0002(),
  new ColumnProfiles0003(),
  new RbacRolesAndPermissions0004(),
  new OntologyVersionsAndConcepts0005(),
  new TableAndColumnComments0006(),
  new DropObjectEntries0007(),
  new MaterializationJobs0008(),
  new MaterializationJobKind0009(),
  new OrphanTargetCleanup0010(),
  new OAuthTables0011(),
  new MaterializeJobCursor0012(),
  new ListMetricsDefaultOpen0013(),
  new OdsTables0014(),
  new OdsReconcile0015(),
  new InstanceHistory0016(),
  new DropLegacyObjectMaterialization0017(),
];
