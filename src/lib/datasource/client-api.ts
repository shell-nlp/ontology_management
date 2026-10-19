import { api } from "@/lib/shared/client/api-client";
import type { DataSourceHealth, DataViewField, DataViewPreview, DataViewSummary, PublicDataSource } from "@/lib/datasource/types";
import type { PendingSource } from "@/lib/datasource/source-binding";

export type DataSourceViewsResponse = { views: DataViewSummary[]; fetched_at?: string; from_cache?: boolean };
export type DataViewResponse = { fields: DataViewField[]; preview: DataViewPreview; fetched_at?: string; from_cache?: boolean };
export type SourceBindingResponse = { versionId: string; versionStatus: string; pendingSources: PendingSource[]; dataSources: { id: string; name: string; kind: string }[] };

export const dataSourcesApi = {
  list: () => api<PublicDataSource[]>("/api/data-sources"),
  listViews: (id: string, query: { limit?: number; schema?: string; refresh?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.schema) params.set("schema", query.schema);
    if (query.refresh) params.set("refresh", "1");
    return api<DataSourceViewsResponse>(`/api/data-sources/${encodeURIComponent(id)}/views?${params}`);
  },
  describeView: (id: string, view: string, query: { limit?: number; schema?: string; refresh?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.schema) params.set("schema", query.schema);
    if (query.refresh) params.set("refresh", "1");
    return api<DataViewResponse>(`/api/data-sources/${encodeURIComponent(id)}/views/${encodeURIComponent(view)}?${params}`);
  },
  test: (id: string) => api<DataSourceHealth>(`/api/data-sources/${encodeURIComponent(id)}/test`, { method: "POST" }),
  testDraft: (body: Record<string, unknown>) => api<DataSourceHealth>("/api/data-sources/test", { method: "POST", body: JSON.stringify(body) }),
  create: (body: Record<string, unknown>) => api<PublicDataSource>("/api/data-sources", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, patch: Record<string, unknown>) => api<PublicDataSource>(`/api/data-sources/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => api(`/api/data-sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  bindings: (ontologyId: string) => api<SourceBindingResponse>(`/api/ontologies/${encodeURIComponent(ontologyId)}/bind-sources`),
  saveBindings: (ontologyId: string, versionId: string, bindings: Record<string, string>) => api(`/api/ontologies/${encodeURIComponent(ontologyId)}/bind-sources`, { method: "POST", body: JSON.stringify({ versionId, bindings }) }),
};
