import { createHash } from "node:crypto";

const MAX_READABLE_LENGTH = 44;

function readablePart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function shortenReadable(value: string) {
  if (value.length <= MAX_READABLE_LENGTH) return value;
  const head = Math.ceil((MAX_READABLE_LENGTH - 1) * 0.62);
  const tail = MAX_READABLE_LENGTH - 1 - head;
  return `${value.slice(0, head)}_${value.slice(-tail)}`;
}

/**
 * 物理表名优先保留 schema 和原始表名，末尾追加稳定短哈希避免跨来源重名。
 * 哈希只取 12 位十六进制；可读前缀有长度上限，超长表名保留头尾。
 */
export function odsTableName(dataSourceId: string, schema: string, table: string) {
  const readable = shortenReadable(
    [readablePart(schema) || "default", readablePart(table) || "table"].join("_"),
  );
  const digest = createHash("sha256")
    .update(`${dataSourceId}\u0000${schema}\u0000${table}`)
    .digest("hex")
    .slice(0, 12);
  return `ods_${readable}_${digest}`;
}
