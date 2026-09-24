import path from "node:path";

export type AppConfig = {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  allowedEmail: string;
  encryptionKey: Buffer;
  databasePath: string;
};

export function getSetupIssues(): string[] {
  const issues: string[] = [];
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "ALLOWED_EMAIL",
    "APP_ENCRYPTION_KEY",
  ]) {
    if (!process.env[name]?.trim()) issues.push(name);
  }
  if (process.env.ALLOWED_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.ALLOWED_EMAIL.trim())) issues.push("ALLOWED_EMAIL format");
  if (process.env.GOOGLE_REDIRECT_URI) {
    try {
      const url = new URL(process.env.GOOGLE_REDIRECT_URI);
      if (url.pathname !== "/api/auth/google/callback") issues.push("GOOGLE_REDIRECT_URI path");
      if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        issues.push("GOOGLE_REDIRECT_URI HTTPS");
      }
    } catch {
      issues.push("GOOGLE_REDIRECT_URI format");
    }
  }
  if (process.env.APP_ENCRYPTION_KEY) {
    try {
      const key = decodeEncryptionKey(process.env.APP_ENCRYPTION_KEY);
      if (key.length !== 32) issues.push("APP_ENCRYPTION_KEY length");
    } catch {
      issues.push("APP_ENCRYPTION_KEY format");
    }
  }
  return issues;
}

function decodeEncryptionKey(value: string): Buffer {
  const cleaned = value.trim();
  if (/^[0-9a-f]{64}$/i.test(cleaned)) return Buffer.from(cleaned, "hex");
  if (!/^[A-Za-z0-9_-]{43,44}={0,2}$/.test(cleaned)) throw new Error("Invalid encryption key");
  return Buffer.from(cleaned, "base64url");
}

export function getConfig(): AppConfig {
  const issues = getSetupIssues();
  if (issues.length) throw new Error(`Configuratie ontbreekt of is ongeldig: ${issues.join(", ")}`);
  const customDbPath = process.env.DATABASE_PATH?.trim();
  const databasePath = customDbPath
    ? path.isAbsolute(customDbPath) ? customDbPath : path.join(/*turbopackIgnore: true*/ process.cwd(), customDbPath)
    : path.join(process.cwd(), "data", "regelradar.sqlite");
  return {
    googleClientId: process.env.GOOGLE_CLIENT_ID!,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI!,
    allowedEmail: process.env.ALLOWED_EMAIL!.trim().toLowerCase(),
    encryptionKey: decodeEncryptionKey(process.env.APP_ENCRYPTION_KEY!),
    databasePath,
  };
}
