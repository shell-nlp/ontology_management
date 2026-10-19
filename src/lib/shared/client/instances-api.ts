import { api } from "@/lib/shared/client/api-client";

export type EntityApiRow = { id: string; labels: string[]; properties: Record<string, unknown> };
export type RelationshipApiRow = { id: string; type: string; sourceId: string; targetId: string; properties: Record<string, unknown> };

export const instancesApi = {
  listEntities: (query: URLSearchParams) => api<{ rows: EntityApiRow[] }>(`/api/instances/entities?${query}`),
  getEntity: (id: string, query: URLSearchParams) => api<EntityApiRow>(`/api/instances/entities/${encodeURIComponent(id)}?${query}`),
  createEntity: (body: Record<string, unknown>) => api<EntityApiRow>("/api/instances/entities", { method: "POST", body: JSON.stringify(body) }),
  updateEntity: (id: string, query: URLSearchParams, properties: Record<string, unknown>) => api<EntityApiRow>(`/api/instances/entities/${encodeURIComponent(id)}?${query}`, { method: "PATCH", body: JSON.stringify({ properties }) }),
  deleteEntity: (id: string, query: URLSearchParams) => api(`/api/instances/entities/${encodeURIComponent(id)}?${query}`, { method: "DELETE" }),
  listRelationships: (query: URLSearchParams) => api<{ rows: RelationshipApiRow[] }>(`/api/instances/relationships?${query}`),
  createRelationship: (body: Record<string, unknown>) => api<RelationshipApiRow>("/api/instances/relationships", { method: "POST", body: JSON.stringify(body) }),
  updateRelationship: (id: string, query: URLSearchParams, properties: Record<string, unknown>) => api<RelationshipApiRow>(`/api/instances/relationships/${encodeURIComponent(id)}?${query}`, { method: "PATCH", body: JSON.stringify({ properties }) }),
  deleteRelationship: (id: string, query: URLSearchParams) => api(`/api/instances/relationships/${encodeURIComponent(id)}?${query}`, { method: "DELETE" }),
};
