import { NextRequest, NextResponse } from "next/server";
import { getConfig, getSetupIssues } from "@/lib/config";
import { completeGoogleAuthorization } from "@/lib/google";
import { createSession, safeEqual, sessionCookieOptions, SESSION_COOKIE, STATE_COOKIE } from "@/lib/security";
import { json } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const issues = getSetupIssues();
  if (issues.length) return json({ error: "Regelradar is nog niet geconfigureerd.", setupIssues: issues }, 503);
  const origin = new URL(getConfig().googleRedirectUri).origin;
  const destination = new URL("/", origin);
  const expected = req.cookies.get(STATE_COOKIE)?.value;
  const received = req.nextUrl.searchParams.get("state");
  const code = req.nextUrl.searchParams.get("code");
  if (!expected || !received || !safeEqual(expected, received) || !code || req.nextUrl.searchParams.has("error")) {
    destination.searchParams.set("auth_error", "ongeldige-aanmelding");
    const response = NextResponse.redirect(destination);
    response.cookies.delete(STATE_COOKIE);
    return response;
  }
  try {
    const email = await completeGoogleAuthorization(code);
    const response = NextResponse.redirect(destination);
    response.cookies.set(SESSION_COOKIE, createSession(email), sessionCookieOptions());
    response.cookies.delete(STATE_COOKIE);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const detail = error as { code?: unknown; response?: { status?: unknown } };
    console.error("[regelradar] Google OAuth callback failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof detail?.code === "string" ? detail.code : undefined,
      status: typeof detail?.response?.status === "number" ? detail.response.status : undefined,
    });
    destination.searchParams.set("auth_error", "koppeling-mislukt");
    const response = NextResponse.redirect(destination);
    response.cookies.delete(STATE_COOKIE);
    return response;
  }
}
