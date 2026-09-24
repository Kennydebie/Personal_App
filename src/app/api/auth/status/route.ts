import { NextRequest } from "next/server";
import { getSetupIssues } from "@/lib/config";
import { getCredential, DatabaseOwnerMismatchError } from "@/lib/db";
import { GOOGLE_SCOPES } from "@/lib/google";
import { json } from "@/lib/api";
import { readSession } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const setupIssues = getSetupIssues();
  if (setupIssues.length) return json({ authenticated: false, connected: false, loginUrl: "/api/auth/google/start", setupIssues });
  const authenticated = Boolean(readSession(req));
  try {
    const credential = authenticated ? getCredential() : null;
    const connected = Boolean(credential && [GOOGLE_SCOPES[2], GOOGLE_SCOPES[3], GOOGLE_SCOPES[4]].some((scope) => credential.scopes.includes(scope)));
    return json({ authenticated, connected, loginUrl: "/api/auth/google/start", setupIssues: [] });
  } catch (error) {
    if (error instanceof DatabaseOwnerMismatchError) return json({ authenticated: false, connected: false, loginUrl: "/api/auth/google/start", setupIssues: ["De database hoort bij een ander account. Herstel ALLOWED_EMAIL of verplaats het oude SQLite-bestand."] });
    throw error;
  }
}
