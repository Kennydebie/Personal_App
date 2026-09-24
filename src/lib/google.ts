import { google } from "googleapis";
import { getConfig } from "./config";
import { getCredential, saveCredential, setSourceConnection } from "./db";
import { decrypt, encrypt } from "./security";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
] as const;

type TokenBundle = {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string | null;
  expiry_date?: number | null;
  id_token?: string | null;
};

function newOAuthClient() {
  const config = getConfig();
  return new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);
}

export function googleAuthorizationUrl(state: string): string {
  return newOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    login_hint: getConfig().allowedEmail,
    scope: [...GOOGLE_SCOPES],
    state,
  });
}

export async function completeGoogleAuthorization(code: string): Promise<string> {
  const oauth = newOAuthClient();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.id_token) throw new Error("Google heeft geen identiteitstoken teruggegeven.");
  const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: getConfig().googleClientId });
  const payload = ticket.getPayload();
  const email = payload?.email?.trim().toLowerCase();
  if (!email || !payload?.email_verified || email !== getConfig().allowedEmail) {
    throw new Error("Dit Google-account heeft geen toegang tot Regelradar.");
  }
  const old = getCredential();
  const oldTokens = old?.email === email ? decrypt<TokenBundle>(old.encryptedTokens) : null;
  const merged = { ...oldTokens, ...tokens, refresh_token: tokens.refresh_token || oldTokens?.refresh_token };
  if (!merged.refresh_token) throw new Error("Google heeft geen verversingstoken gegeven; probeer opnieuw te koppelen.");
  const scopes = tokens.scope
    ? tokens.scope.split(/\s+/).filter(Boolean)
    : tokens.access_token
      ? (await oauth.getTokenInfo(tokens.access_token)).scopes
      : [];
  saveCredential(email, scopes, encrypt(merged));
  setSourceConnection("gmail", scopes.includes(GOOGLE_SCOPES[2]), scopes.includes(GOOGLE_SCOPES[2]) ? null : "Gmail-leestoegang is niet verleend.");
  const calendarOk = scopes.includes(GOOGLE_SCOPES[3]) && scopes.includes(GOOGLE_SCOPES[4]);
  setSourceConnection("calendar", calendarOk, calendarOk ? null : "Agenda-leestoegang is niet volledig verleend.");
  return email;
}

export function getGoogleClient() {
  const credential = getCredential();
  if (!credential || credential.email !== getConfig().allowedEmail) return null;
  const oauth = newOAuthClient();
  let stored = decrypt<TokenBundle>(credential.encryptedTokens);
  oauth.setCredentials(stored);
  oauth.on("tokens", (tokens) => {
    stored = { ...stored, ...tokens, refresh_token: tokens.refresh_token || stored.refresh_token };
    saveCredential(credential.email, credential.scopes, encrypt(stored));
  });
  return { oauth, email: credential.email, scopes: credential.scopes };
}

export function isGoogleScopeGranted(scope: string): boolean {
  return Boolean(getCredential()?.scopes.includes(scope));
}

export async function revokeGoogleTokens(): Promise<boolean> {
  const credential = getCredential();
  if (!credential) return true;
  const tokens = decrypt<TokenBundle>(credential.encryptedTokens);
  if (!tokens.refresh_token && !tokens.access_token) return false;
  try {
    await newOAuthClient().revokeToken(tokens.refresh_token || tokens.access_token!);
    return true;
  } catch {
    return false;
  }
}
