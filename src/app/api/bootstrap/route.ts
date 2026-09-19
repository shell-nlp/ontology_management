import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { countUsers, insertUser } from "@/lib/platform-db";

export async function POST() {
  try {
    if (await countUsers()) return NextResponse.json({ created: false, reason: "ALREADY_INITIALIZED" }, { status: 409 });

    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!email || !password) return NextResponse.json({ error: "BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required." }, { status: 400 });

    await insertUser({ email, passwordHash: await bcrypt.hash(password, 12), role: "ADMIN" });
    return NextResponse.json({ created: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bootstrap failed." }, { status: 500 });
  }
}
