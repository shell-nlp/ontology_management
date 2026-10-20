/** Start persistent background maintenance with the long-running Node server. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_TEST_DIST_DIR) return;
  const { ensurePlatformSchema } = await import("@/lib/infrastructure/persistence/postgres");
  await ensurePlatformSchema();
  const { listOdsJobs, ensureOdsReconcileScheduler } = await import("@/lib/instance/ods/service");
  await listOdsJobs();
  ensureOdsReconcileScheduler();
}
