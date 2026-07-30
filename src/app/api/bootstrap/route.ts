import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { ensurePlatformSchema, platformQuery } from "@/lib/platform-db";

export async function POST() {
  try {
    await ensurePlatformSchema();
    const existing = await platformQuery<{ count: string }>("SELECT count(*)::text AS count FROM ontology_platform.users");
    if (existing.rows[0]?.count !== "0") return NextResponse.json({ created: false, reason: "ALREADY_INITIALIZED" }, { status: 409 });

    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!email || !password) return NextResponse.json({ error: "BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required." }, { status: 400 });

    await platformQuery(
      "INSERT INTO ontology_platform.users (id, email, password_hash, role) VALUES ($1, $2, $3, 'ADMIN')",
      [crypto.randomUUID(), email.toLowerCase(), await bcrypt.hash(password, 12)],
    );
    return NextResponse.json({ created: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bootstrap failed." }, { status: 500 });
  }
}
