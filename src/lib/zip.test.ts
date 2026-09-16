import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createZip, crc32 } from "@/lib/zip";

/** 按 zip 结构把条目读回来：EOCD → 中央目录 → 本地头 → 数据。 */
function readZip(buffer: Buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries: { path: string; content: string; crc: number; method: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressed);
    entries.push({ path: name, content: (method === 8 ? inflateRawSync(data) : data).toString("utf8"), crc, method });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { count, entries };
}

describe("zip 打包", () => {
  it("CRC32 与标准值一致", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from(""))).toBe(0);
  });

  it("打出来的包能按 zip 结构读回原文，文件名的 UTF-8 标记与 CRC 都对", () => {
    const files = [
      { path: "ontology-bundle/SKILL.md", content: "# 标题\n\n正文\n" },
      { path: "ontology-bundle/references/example.bundle.json", content: JSON.stringify({ a: 1, 中文: "值" }) },
      { path: "ontology-bundle/references/short.txt", content: "x" },
    ];
    const zip = createZip(files, new Date("2026-09-16T10:00:00Z"));
    const { count, entries } = readZip(zip);
    expect(count).toBe(3);
    expect(entries.map((entry) => entry.path)).toEqual(files.map((file) => file.path));
    for (const [index, entry] of entries.entries()) {
      expect(entry.content).toBe(files[index].content);
      expect(entry.crc).toBe(crc32(Buffer.from(files[index].content)));
      expect([0, 8]).toContain(entry.method);
    }
    // 文件名的 UTF-8 位（0x0800）必须置上，否则中文/路径在 Windows 上会乱码。
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it("压不小的内容走原样存储", () => {
    const zip = createZip([{ path: "tiny.txt", content: "a" }]);
    const { entries } = readZip(zip);
    expect(entries[0].method).toBe(0);
  });
});