import { NextRequest } from "next/server";
import { guard, json } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/security";

export const runtime = "nodejs";

export function POST(req: NextRequest) {
  const denied = guard(req, true);
  if (denied) return denied;
  const response = json({ loggedOut: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
