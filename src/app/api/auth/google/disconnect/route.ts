import { NextRequest } from "next/server";
import { guard, json } from "@/lib/api";
import { clearCredential } from "@/lib/db";
import { revokeGoogleTokens } from "@/lib/google";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const denied = guard(req, true);
  if (denied) return denied;
  const googleRevoked = await revokeGoogleTokens();
  clearCredential();
  return json({ disconnected: true, googleRevoked });
}
