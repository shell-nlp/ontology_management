import { NextResponse } from "next/server";
import { currentUser } from "@/lib/platform/auth";
import { withPublic } from "@/lib/platform/route-guard";

export const GET = withPublic(async () => {
  const user = await currentUser();
  return NextResponse.json({ user });
});
