import type { QueryRunner } from "typeorm";
import { platformCommentStatements } from "@/lib/platform/db/comments";

/**
 * OAuth 授权服务器（本地 AS）的三张表：客户端、授权码、刷新令牌。
 *
 * 为什么要落到库上：授权码必须**一次性**且能扛住多进程与重启（生产是 `next start` 多实例，
 * 进程内 Map 一重启就全丢）；客户端清单要能管、能撤；刷新令牌要能轮换。
 *
 * 建完表顺手把这几张表的注释也补上：注释的唯一出处是 `@/lib/platform/db/comments`，
 * 而迁移 0006 在本支之前跑，那时这几张表还不存在 —— 不在这里补，就要等下一次启动才有注释。
 */
export class OAuthTables0011 {
  name = "OAuthTables0011";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.oauth_clients (
        id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
        source TEXT NOT NULL DEFAULT 'DCR',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT,
        disabled_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.oauth_authorization_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        scope TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ
      )
    `);
    // 过期的码没人会再换，但会一直堆着；这张表按签发时间收窄查询，清理也按它。
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS oauth_authorization_codes_created_idx ON ontology_platform.oauth_authorization_codes (created_at DESC)`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.oauth_refresh_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ
      )
    `);
    // 撤销一个账号时按 user_id 找它的刷新令牌（外键是 SET NULL 的那种风格，这里不建外键）。
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_user_idx ON ontology_platform.oauth_refresh_tokens (user_id, created_at DESC)`,
    );

    // 只补这三张表的注释（注释文案的唯一出处是 @/lib/platform/db/comments）。
    const mine = ["oauth_clients", "oauth_authorization_codes", "oauth_refresh_tokens"];
    const isMine = (statement: string) =>
      mine.some((table) =>
        statement.startsWith("COMMENT ON TABLE ontology_platform." + table + " IS ") ||
        statement.startsWith("COMMENT ON COLUMN ontology_platform." + table + "."));
    for (const statement of platformCommentStatements()) {
      if (!isMine(statement)) continue;
      await queryRunner.query(statement);
    }
  }
}
