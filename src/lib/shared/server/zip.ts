import { deflateRawSync } from "node:zlib";

/**
 * 最小 ZIP 打包器：只做一件事 —— 把几个内存里的文件打成一个能解压的 .zip。
 *
 * 为什么自己写：平台的技能包、示例包要能"一次下载、解压即用"，而 zip 是唯一通用格式；
 * 但为这一个用途引一个打包库（含 zip64 / 加密 / 流式 API）不划算。这里只实现
 * **store + deflate、UTF-8 文件名、无 zip64** 的子集，条目数 < 65536、单文件 < 4GB，
 * 足够装 Markdown 与 JSON。
 *
 * 校验方式是实测：单元测试比对 CRC32 已知值，端到端用系统解压（Expand-Archive / unzip）验一次。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC32（IEEE 802.3），zip 的每个条目都要它。 */
export function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS 时间格式：1980 起算，秒只有 2 秒精度。 */
function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export type ZipEntry = { path: string; content: string | Buffer };

/** 打包。`path` 是压缩包里的相对路径，用 `/` 分隔。 */
export function createZip(entries: readonly ZipEntry[], now = new Date()): Buffer {
  if (entries.length > 65535) throw new Error("ZIP 条目太多（上限 65535）。");
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, "/"), "utf8");
    const raw = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
    const deflated = deflateRawSync(raw);
    // 压不小就原样存（小文件、已压缩内容很常见）。
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}