import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isUnauthorized, requireRole } from "@/lib/auth";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getGraphStore } from "@/lib/graph";
import type { GraphTarget, GraphTargetKind } from "@/lib/graph/types";
import { describeTargetError, getTarget, parseTargetOptions } from "@/lib/targets";

/**
 * 试连一个还没保存（或刚改过）的本体存储：弹窗里的「测试连接」用它。
 * 只做一次连接探测，不落库、不改图数据。
 */
const testInput = z.object({
  kind: z.enum(["JENA", "EMBEDDED"]).default("JENA"),
  uri: z.string().trim().url().optional(),
  databaseName: z.string().trim().min(1).max(100).default("ds"),
  username: z.string().trim().max(100).default(""),
  password: z.string().max(500).default(""),
  options: z.record(z.string(), z.unknown()).default({}),
  /** 编辑时带上：密码留空就沿用已保存的那份凭据，不用逼人重填。 */
  targetId: z.string().uuid().optional(),
});

export async function POST(request: NextRequest) {
  // 解析失败时也要按用户选的类型给提示，所以 kind 提到 try 外面。
  let kind: GraphTargetKind = "JENA";
  try {
    await requireRole("ADMIN");
    const input = testInput.parse(await request.json());
    kind = input.kind;
    if (kind === "JENA" && !input.uri) throw new Error("请填写 Jena 服务地址。");
    let password = input.password;
    if (!password && input.targetId) {
      const stored = await getTarget(input.targetId);
      password = stored?.credential_secret ? decryptSecret(stored.credential_secret) : "";
    }
    const draft: GraphTarget = {
      id: input.targetId ?? "unsaved",
      name: "连接测试",
      kind,
      uri: kind === "EMBEDDED" ? "embedded://platform" : input.uri!,
      database_name: kind === "EMBEDDED" ? "platform" : input.databaseName,
      username: input.username,
      // 图库适配器拿到的是密文，这里保持同样的形态：先加密再交给它。
      credential_secret: password ? encryptSecret(password) : "",
      options: parseTargetOptions(input.options),
      created_at: new Date(),
    };
    const info = await getGraphStore(draft).testConnection();
    return NextResponse.json(info);
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    return NextResponse.json({ error: unauthorized ? "未授权。" : describeTargetError(kind, error) }, { status: unauthorized ? 401 : 400 });
  }
}
