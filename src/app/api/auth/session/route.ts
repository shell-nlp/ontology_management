import { NextResponse } from "next/server";
import { currentUser } from "@/lib/platform/auth";

export async function GET() {
  const user = await currentUser();
  return NextResponse.json({ user });
}
