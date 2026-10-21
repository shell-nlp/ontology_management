"use client";

import { AlertTriangle, ArrowUpRight, Boxes, X } from "lucide-react";
import "./ods-publish-blockers.css";
import "./graph-canvas.css";

export type OdsPublishBlockerView = {
  entityTypeId: string;
  entityType: string;
  dataSourceId: string;
  schema: string;
  table: string;
  reason: string;
  status?: string;
};

function tableName(blocker: OdsPublishBlockerView) {
  return [blocker.schema, blocker.table].filter(Boolean).join(".");
}

export function OdsPublishBlockers({ blockers, onOpen, onClose }: {
  blockers: OdsPublishBlockerView[];
  onOpen: (blocker: OdsPublishBlockerView) => void;
  onClose: () => void;
}) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dialog graph-dialog ods-publish-blockers" role="dialog" aria-modal="true" aria-labelledby="ods-publish-blockers-title">
      <button type="button" className="close-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
      <div className="ods-publish-head">
        <span><AlertTriangle size={22} /></span>
        <div>
          <small>发布被 ODS 校验阻止</small>
          <h2 id="ods-publish-blockers-title">先补齐 READY 的 ODS 镜像</h2>
          <p>含本地 CRUD 的对象类型，发布后必须落到 ODS。完成镜像配置和全量同步后再发布，源业务库不会被写入。</p>
        </div>
      </div>
      <div className="ods-publish-list">
        {blockers.map((blocker) => <article key={`${blocker.entityTypeId}:${blocker.dataSourceId}:${blocker.table}`}>
          <span className="ods-publish-icon"><Boxes size={16} /></span>
          <div>
            <b>{blocker.entityType}</b>
            <code>{tableName(blocker) || "未绑定数据来源"}</code>
            <p>{blocker.reason}</p>
          </div>
          <button
            type="button"
            className="action compact"
            disabled={!blocker.dataSourceId || !blocker.table}
            onClick={() => onOpen(blocker)}
            title={blocker.dataSourceId && blocker.table ? "打开数据资源并定位到这张表" : "先到对象类型编辑里绑定数据来源"}
          >
            去配置 ODS<ArrowUpRight size={13} />
          </button>
        </article>)}
      </div>
      <footer className="dialog-actions">
        <button type="button" className="action" onClick={onClose}>稍后处理</button>
      </footer>
    </section>
  </div>;
}
