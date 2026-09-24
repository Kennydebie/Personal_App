import { NextRequest } from "next/server";
import { guard, json } from "@/lib/api";
import { getDashboard } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const denied = guard(req);
  return denied || json(getDashboard());
}
