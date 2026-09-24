import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getConfig } from "./config";

export const SESSION_COOKIE = "regelradar_session";
export const STATE_COOKIE = "regelradar_oauth_state";
const SESSION_SECONDS = 60 * 60 * 24 * 14;

function keyFor(label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", getConfig().encryptionKey, "regelradar-v1", label, 32));
}

export function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor("database"), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt<T>(value: string): T {
  const [iv, tag, data] = value.split(".");
  if (!iv || !tag || !data) throw new Error("Invalid encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", keyFor("database"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")) as T;
}

function sign(value: string): string {
  return createHmac("sha256", keyFor("session")) .update(value).digest("base64url");
}

export function createSession(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readSession(req: NextRequest): string | null {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  const actual = Buffer.from(mac, "base64url");
  const comparison = Buffer.from(expected, "base64url");
  if (actual.length !== comparison.length || !timingSafeEqual(actual, comparison)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email: string; exp: number };
    return session.exp > Date.now() / 1000 && session.email.toLowerCase() === getConfig().allowedEmail ? session.email : null;
  } catch {
    return null;
  }
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) return false;
  if (origin) return origin === req.nextUrl.origin;
  return fetchSite === "same-origin" || fetchSite === "none";
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_SECONDS,
};
