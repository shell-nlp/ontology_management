import { api } from "@/lib/shared/client/api-client";

export type OntologyApiItem = {
  id: string; identifier: string; name: string; description: string; color: string; tags: string[];
  target_id: string; namespace: string | null; created_by: string | null; updated_at: string;
  storage: { id: string; name: string; kind: string; kindLabel: string; uri: string; managed: boolean } | null;
  versions: { draft: number | null; published: number | null };
  statistics: { objectTypes: number; relationTypes: number; objects: number; relationships: number };
};

export const ontologyApi = {
  list: () => api<OntologyApiItem[]>("/api/ontologies"),
  create: (body: Record<string, unknown>) => api<{ id: string }>("/api/ontologies", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, patch: Record<string, unknown>) => api<OntologyApiItem>(`/api/ontologies/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => api(`/api/ontologies/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
