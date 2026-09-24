import { NextRequest, NextResponse } from "next/server";
import { getSetupIssues } from "./config";
import { database, DatabaseOwnerMismatchError } from "./db";
import { readSession, sameOrigin } from "./security";

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function guard(req: NextRequest, mutation = false): NextResponse | null {
  const issues = getSetupIssues();
  if (issues.length) return json({ error: "Regelradar is nog niet geconfigureerd.", setupIssues: issues }, 503);
  if (!readSession(req)) return json({ error: "Aanmelden vereist." }, 401);
  if (mutation && !sameOrigin(req)) return json({ error: "Ongeldige aanvraagbron." }, 403);
  try { database(); } catch (error) {
    if (error instanceof DatabaseOwnerMismatchError) return json({ error: "De opgeslagen gegevens horen bij een ander account. Verwijder de lokale database via een beheerder voordat je dit account gebruikt.", setupIssues: ["DATABASE_OWNER_MISMATCH"] }, 409);
    throw error;
  }
  return null;
}
