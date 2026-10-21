import { listVersionRecords } from "@/lib/versioning/snapshot";

export async function getPublishedVersion(targetId: string) {
  const records = await listVersionRecords(targetId);
  const published = records.find((record) => record.status === "PUBLISHED");
  if (!published) throw new Error("该本体存储尚未发布本体，不能管理对象或关系。");
  return published;
}

export async function getPublishedOntology(targetId: string) {
  return (await getPublishedVersion(targetId)).definition;
}
