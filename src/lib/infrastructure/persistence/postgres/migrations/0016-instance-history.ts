import type { QueryRunner } from "typeorm";
import { platformCommentStatements } from "../comments";

export class InstanceHistory0016 {
  name = "InstanceHistory0016";
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE IF NOT EXISTS ontology_platform.instance_history (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, version_id TEXT NOT NULL, definition JSONB NOT NULL, entity_types JSONB NOT NULL, status TEXT NOT NULL, rows BIGINT NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ)`);
    await runner.query(`CREATE TABLE IF NOT EXISTS ontology_platform.instance_history_chunks (snapshot_id TEXT NOT NULL REFERENCES ontology_platform.instance_history(id) ON DELETE CASCADE, page INTEGER NOT NULL, entity_type TEXT NOT NULL, rows INTEGER NOT NULL, payload BYTEA NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(snapshot_id,page))`);
    for (const statement of platformCommentStatements()) if (statement.includes("ontology_platform.instance_history")) await runner.query(statement);
  }
}
