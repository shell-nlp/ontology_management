import { listVersionRecords } from "@/lib/version-snapshot";

export async function getPublishedOntology(targetId: string) {
  const records = await listVersionRecords(targetId);
  const published = records.find((record) => record.status === "PUBLISHED");
  if (!published) throw new Error("该目标尚未发布本体，不能管理对象或关系。");
  return published.definition;
}
