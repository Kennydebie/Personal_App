import { NextResponse } from "next/server";
import { getSetupIssues } from "@/lib/config";
import { database, DatabaseOwnerMismatchError } from "@/lib/db";
import { googleAuthorizationUrl } from "@/lib/google";
import { createOAuthState, STATE_COOKIE } from "@/lib/security";
import { json } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const issues = getSetupIssues();
  if (issues.length) return json({ error: "Regelradar is nog niet geconfigureerd.", setupIssues: issues }, 503);
  try { database(); } catch (error) {
    if (error instanceof DatabaseOwnerMismatchError) return json({ error: "De opgeslagen gegevens horen bij een ander account.", setupIssues: ["DATABASE_OWNER_MISMATCH"] }, 409);
    throw error;
  }
  const state = createOAuthState();
  const response = NextResponse.redirect(googleAuthorizationUrl(state));
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 600,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
