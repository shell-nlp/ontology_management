import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVersionRecord, deleteTargetVersions, getVersionRecord, listVersionRecords, updateVersionRecord } from "@/lib/version-snapshot";
import type { OntologyDefinition } from "@/lib/ontology";

let tempDir: string | undefined;

afterEach(async () => {
  delete process.env.ONTOLOGY_VERSION_DIR;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function useTempRoot() {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ontology-versions-"));
  process.env.ONTOLOGY_VERSION_DIR = tempDir;
  return tempDir;
}

const targetId = "99999999-9999-4999-8999-999999999999";
const emptyDefinition: OntologyDefinition = { groups: [], entityTypes: [], relationshipTypes: [], actionTypes: [], rules: [] };

describe("file-based version store", () => {
  it("creates, lists, reads and updates version records", async () => {
    await useTempRoot();
    const created = await createVersionRecord({ targetId, versionNumber: 1, createdBy: "user-1", definition: emptyDefinition });
    expect(created.status).toBe("DRAFT");
    expect(created.version_number).toBe(1);
    expect(created.content_hash).toBeNull();
    expect(created.artifact_path).toBeTruthy();

    const listed = await listVersionRecords(targetId);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);

    const fetched = await getVersionRecord(created.id);
    expect(fetched?.target_id).toBe(targetId);
    expect(fetched?.definition.entityTypes).toEqual([]);

    await updateVersionRecord(created.id, { status: "PUBLISHED", publishedAt: new Date().toISOString() });
    const published = await getVersionRecord(created.id);
    expect(published?.status).toBe("PUBLISHED");
    expect(published?.published_at).toBeTruthy();
  });

  it("deletes all version records of a target", async () => {
    await useTempRoot();
    await createVersionRecord({ targetId, versionNumber: 1, createdBy: "user-1", definition: emptyDefinition });
    await createVersionRecord({ targetId, versionNumber: 2, createdBy: "user-1", definition: emptyDefinition });
    expect(await listVersionRecords(targetId)).toHaveLength(2);
    expect(await deleteTargetVersions(targetId)).toBe(2);
    expect(await listVersionRecords(targetId)).toHaveLength(0);
  });
});
