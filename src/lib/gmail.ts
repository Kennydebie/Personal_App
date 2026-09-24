import { google, type gmail_v1 } from "googleapis";
import { extractGmailThread, isExcludedGmailContent, type ParsedMessage, type ParsedThread } from "./extraction";
import { getGoogleClient, GOOGLE_SCOPES } from "./google";
import { getItemBySourceKey, markSourceUnavailable, meta, resolveSourceKey, setMeta, setSourceCheck, setSourceConnection, upsertExtracted } from "./db";
import { decrypt, encrypt } from "./security";
import type { ExtractedItem, ScanResponse } from "./types";

type ChangeDetails = ScanResponse["changes"]["details"];
type OlderSearch = { caseKey: string; subject: string; counterpart: string; before: string; evidenceAt: string; pageToken?: string };

async function searchOlderRelatedThreads(
  gmail: gmail_v1.Gmail,
  email: string,
  checkedAt: string,
  changes: ChangeDetails,
  recent: ExtractedItem | null,
  windowStart: string,
  currentIds: string[],
): Promise<{ partial: boolean; note: string | null; unreadAttachment: boolean }> {
  if (meta("gmail_older_scan_at") === checkedAt) return { partial: Boolean(meta("gmail_older_pending")), note: null, unreadAttachment: false };
  let search: OlderSearch | null = null;
  const encryptedPending = meta("gmail_older_pending");
  if (encryptedPending) {
    try { search = decrypt<OlderSearch>(encryptedPending); } catch { setMeta("gmail_older_pending", null); }
  }
  if (!search && recent?.caseKey && recent.relatedSearch && !meta(`gmail_older_done:${recent.caseKey}`)) {
    search = { caseKey: recent.caseKey, subject: recent.relatedSearch.subject, counterpart: recent.relatedSearch.counterpart, before: windowStart, evidenceAt: recent.evidenceAt };
  }
  if (!search) return { partial: false, note: null, unreadAttachment: false };
  if (!/^[^\s@{}"\\]+@[^\s@{}"\\]+\.[^\s@{}"\\]+$/.test(search.counterpart)) {
    setMeta("gmail_older_pending", null);
    return { partial: true, note: "Gerichte oudere zoekopdracht overgeslagen wegens ongeldige correspondent.", unreadAttachment: false };
  }
  setMeta("gmail_older_scan_at", checkedAt);
  setMeta("gmail_older_pending", encrypt(search));
  const safeSubject = search.subject.replace(/["\\{}]/g, " ").slice(0, 100);
  const q = `before:${Math.floor(Date.parse(search.before) / 1000)} subject:"${safeSubject}" {from:${search.counterpart} to:${search.counterpart}}`;
  try {
    const list = await gmail.users.threads.list({ userId: "me", q, maxResults: 20, pageToken: search.pageToken, includeSpamTrash: false });
    const foundIds = (list.data.threads || []).map((thread) => thread.id).filter((id): id is string => Boolean(id) && !currentIds.includes(id!));
    let unreadAttachment = false;
    let failures = 0;
    for (let index = 0; index < foundIds.length; index += 6) {
      const batch = foundIds.slice(index, index + 6);
      const fetched = await Promise.allSettled(batch.map((id) => gmail.users.threads.get({ userId: "me", id, format: "full" })));
      for (let offset = 0; offset < batch.length; offset++) {
        const result = fetched[offset];
        if (result.status === "rejected") { failures++; continue; }
        const parsed = parseGoogleThread(result.value.data);
        const candidate = extractGmailThread(parsed, email).candidate;
        if (!candidate || candidate.caseKey !== search.caseKey) continue;
        if (Math.abs(Date.parse(candidate.evidenceAt) - Date.parse(search.evidenceAt)) > 45 * 86_400_000) continue;
        if (candidate.uncertainty?.includes("Bijlagen")) unreadAttachment = true;
        const change = upsertExtracted(candidate, checkedAt);
        if (change !== "unchanged") {
          const item = getItemBySourceKey(candidate.sourceKey);
          if (item) changes[change].push({ id: item.id, title: item.title });
        }
      }
    }
    if (failures) return { partial: true, note: `${failures} oudere gerelateerde threads konden niet worden gelezen; de zoekpagina blijft bewaard.`, unreadAttachment };
    const nextPage = list.data.nextPageToken || undefined;
    if (nextPage) {
      setMeta("gmail_older_pending", encrypt({ ...search, pageToken: nextPage }));
      return { partial: true, note: "Gerichte oudere zoekopdracht heeft meer pagina’s; de volgende controle gaat verder.", unreadAttachment };
    }
    setMeta(`gmail_older_done:${search.caseKey}`, checkedAt);
    setMeta("gmail_older_pending", null);
    return { partial: false, note: "Gerichte oudere berichten over één gevonden zaak gecontroleerd.", unreadAttachment };
  } catch {
    return { partial: true, note: "Gerichte oudere zoekopdracht kon niet worden voltooid; de volgende controle probeert opnieuw.", unreadAttachment: false };
  }
}

function header(message: gmail_v1.Schema$Message, name: string): string {
  return message.payload?.headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function decodePart(data?: string | null): string {
  if (!data) return "";
  try { return Buffer.from(data, "base64url").toString("utf8"); } catch { return ""; }
}

function htmlToText(html: string): string {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?\s*>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}

function bodyAndAttachments(payload: gmail_v1.Schema$MessagePart | undefined): { body: string; attachments: string[] } {
  if (!payload) return { body: "", attachments: [] };
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: string[] = [];
  function walk(part: gmail_v1.Schema$MessagePart): void {
    if (part.filename) attachments.push(part.filename);
    if (part.mimeType === "text/plain") plain.push(decodePart(part.body?.data));
    else if (part.mimeType === "text/html") html.push(htmlToText(decodePart(part.body?.data)));
    for (const child of part.parts || []) walk(child);
  }
  walk(payload);
  return { body: (plain.join("\n") || html.join("\n")).slice(0, 24_000), attachments };
}

export function parseGoogleThread(thread: gmail_v1.Schema$Thread): ParsedThread {
  const messages: ParsedMessage[] = (thread.messages || []).filter((message) => Boolean(message.id)).map((message) => {
    const { body, attachments } = bodyAndAttachments(message.payload || undefined);
    const time = message.internalDate && Number.isFinite(Number(message.internalDate))
      ? Number(message.internalDate)
      : Date.parse(header(message, "date"));
    const date = new Date(Number.isFinite(time) ? time : 0).toISOString();
    return {
      id: message.id!,
      from: header(message, "from"),
      to: header(message, "to"),
      cc: header(message, "cc"),
      subject: header(message, "subject"),
      date,
      body: body || message.snippet || "",
      bulk: Boolean(header(message, "list-unsubscribe"))
        || /(?:no-?reply|do-?not-?reply|newsletter|nieuwsbrief)@/i.test(header(message, "from"))
        || (message.labelIds || []).some((label) => label === "CATEGORY_PROMOTIONS" || label === "CATEGORY_SOCIAL"),
      attachmentNames: attachments,
      sent: (message.labelIds || []).includes("SENT"),
    };
  });
  return { id: thread.id || "", messages };
}

function dateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function historyThreadIds(history: gmail_v1.Schema$History[]): string[] {
  const ids = new Set<string>();
  for (const record of history) {
    for (const message of record.messages || []) if (message.threadId) ids.add(message.threadId);
    for (const entry of record.messagesAdded || []) if (entry.message?.threadId) ids.add(entry.message.threadId);
    for (const entry of record.messagesDeleted || []) if (entry.message?.threadId) ids.add(entry.message.threadId);
    for (const entry of record.labelsAdded || []) if (entry.message?.threadId) ids.add(entry.message.threadId);
    for (const entry of record.labelsRemoved || []) if (entry.message?.threadId) ids.add(entry.message.threadId);
  }
  return [...ids];
}

export async function scanGmail(checkedAt: string, changes: ChangeDetails): Promise<boolean> {
  const client = getGoogleClient();
  const windowStart = meta("gmail_initial_window_start") || dateDaysAgo(90);
  if (!client || !client.scopes.includes(GOOGLE_SCOPES[2])) {
    setSourceConnection("gmail", false, "Gmail is niet aangesloten met leestoegang.");
    return false;
  }
  const gmail = google.gmail({ version: "v1", auth: client.oauth });
  const initial = !meta("gmail_history_id") || Boolean(meta("gmail_initial_page"));
  let ids: string[] = [];
  let nextPage: string | undefined;
  let historyEnd: string | null = null;
  let pageKey: string;
  let attachmentUnreviewed = false;
  let sensitiveSkipped = 0;
  let relatedCandidate: ExtractedItem | null = null;
  try {
    if (initial) {
      pageKey = "gmail_initial_page";
      if (!meta("gmail_initial_window_start")) setMeta("gmail_initial_window_start", windowStart);
      if (!meta("gmail_initial_anchor")) {
        const profile = await gmail.users.getProfile({ userId: "me" });
        if (profile.data.historyId) setMeta("gmail_initial_anchor", profile.data.historyId);
      }
      const response = await gmail.users.threads.list({
        userId: "me",
        q: `after:${Math.floor(Date.parse(windowStart) / 1000)}`,
        maxResults: 100,
        pageToken: meta(pageKey) || undefined,
        includeSpamTrash: false,
      });
      ids = (response.data.threads || []).map((thread) => thread.id).filter((id): id is string => Boolean(id));
      nextPage = response.data.nextPageToken || undefined;
    } else {
      pageKey = "gmail_history_page";
      const base = meta("gmail_history_base") || meta("gmail_history_id")!;
      setMeta("gmail_history_base", base);
      try {
        const response = await gmail.users.history.list({ userId: "me", startHistoryId: base, maxResults: 100, pageToken: meta(pageKey) || undefined });
        ids = historyThreadIds(response.data.history || []);
        nextPage = response.data.nextPageToken || undefined;
        historyEnd = response.data.historyId || null;
      } catch (error) {
        if ((error as { code?: number }).code !== 404) throw error;
        setMeta("gmail_history_id", null);
        setMeta("gmail_history_page", null);
        setMeta("gmail_history_base", null);
        setSourceCheck({ id: "gmail", lastCheckedAt: checkedAt, searchWindowStart: windowStart, searchWindowEnd: checkedAt, result: "mislukt", note: "Gmail-wijzigingsgeschiedenis is verlopen. Volgende scan begint opnieuw bij de laatste 90 dagen." });
        return false;
      }
    }

    const failures: string[] = [];
    let fetchedCount = 0;
    for (let index = 0; index < ids.length; index += 6) {
      const batch = ids.slice(index, index + 6);
      const fetched = await Promise.allSettled(batch.map((id) => gmail.users.threads.get({ userId: "me", id, format: "full" })));
      for (let offset = 0; offset < batch.length; offset++) {
        const result = fetched[offset];
        const sourceKey = `gmail:thread:${batch[offset]}`;
        if (result.status === "rejected") {
          if ((result.reason as { code?: number }).code === 404) {
            if (markSourceUnavailable(sourceKey, checkedAt)) {
              const item = getItemBySourceKey(sourceKey);
              if (item) changes.updated.push({ id: item.id, title: item.title });
            }
          } else failures.push(batch[offset]);
          continue;
        }
        fetchedCount++;
        const parsed = parseGoogleThread(result.value.data);
        if (parsed.messages.some(isExcludedGmailContent)) sensitiveSkipped++;
        const decision = extractGmailThread(parsed, client.email);
        if (decision.candidate) {
          if (!relatedCandidate && decision.candidate.caseKey && decision.candidate.relatedSearch) relatedCandidate = decision.candidate;
          if (decision.candidate.uncertainty?.includes("Bijlagen")) attachmentUnreviewed = true;
          const change = upsertExtracted(decision.candidate, checkedAt);
          if (change !== "unchanged") {
            const item = getItemBySourceKey(sourceKey);
            if (item) changes[change].push({ id: item.id, title: item.title });
          }
        } else if (decision.resolved && resolveSourceKey(sourceKey, checkedAt, decision.reason || "Later afgehandeld.")) {
          const item = getItemBySourceKey(sourceKey);
          if (item) changes[item.status === "afgerond" ? "resolved" : "updated"].push({ id: item.id, title: item.title });
        }
      }
    }
    if (attachmentUnreviewed) setMeta("gmail_attachment_unreviewed", "true");
    if (sensitiveSkipped) setMeta("gmail_sensitive_skipped", "true");
    if (failures.length) {
      setSourceCheck({ id: "gmail", lastCheckedAt: checkedAt, searchWindowStart: windowStart, searchWindowEnd: checkedAt, result: fetchedCount ? "gedeeltelijk" : "mislukt", note: `${failures.length} van ${ids.length} threads konden niet worden gelezen; dezelfde pagina wordt opnieuw geprobeerd.` });
      return false;
    }
    setMeta(pageKey, nextPage || null);
    if (initial && !nextPage) {
      setMeta("gmail_history_id", meta("gmail_initial_anchor"));
      setMeta("gmail_initial_anchor", null);
      setMeta("gmail_initial_window_start", null);
    }
    if (!initial && !nextPage) {
      setMeta("gmail_history_id", historyEnd || meta("gmail_history_id"));
      setMeta("gmail_history_base", null);
    }
    const older = await searchOlderRelatedThreads(gmail, client.email, checkedAt, changes, relatedCandidate, windowStart, ids);
    if (older.unreadAttachment) setMeta("gmail_attachment_unreviewed", "true");
    const unreadAttachments = Boolean(meta("gmail_attachment_unreviewed"));
    const sensitiveExcluded = Boolean(meta("gmail_sensitive_skipped"));
    const partial = Boolean(nextPage || older.partial || unreadAttachments || sensitiveExcluded);
    const note = nextPage
      ? `${ids.length} threads op deze scanpagina gecontroleerd; er zijn nog pagina’s. Druk opnieuw op ‘Nu controleren’.`
      : unreadAttachments
        ? "Gmail-threads gecontroleerd; relevante bijlagen zijn niet inhoudelijk gelezen."
        : `${ids.length} ${initial ? "threads uit de laatste 90 dagen" : "gewijzigde threads"} gecontroleerd.`;
    const finalNote = `${note}${older.note ? ` ${older.note}` : ""}${sensitiveExcluded ? " Mogelijke werk- of cliëntberichten zijn buiten verwerking gehouden." : ""}`;
    setSourceCheck({ id: "gmail", lastCheckedAt: checkedAt, searchWindowStart: windowStart, searchWindowEnd: checkedAt, result: partial ? "gedeeltelijk" : "volledig", note: finalNote });
    return Boolean(nextPage);
  } catch (error) {
    setSourceCheck({ id: "gmail", lastCheckedAt: checkedAt, searchWindowStart: windowStart, searchWindowEnd: checkedAt, result: "mislukt", note: friendlyGoogleError(error) });
    return false;
  }
}

function friendlyGoogleError(error: unknown): string {
  const code = (error as { code?: number }).code;
  if (code === 401 || code === 403) return "Gmail-toegang geweigerd of verlopen. Koppel Google opnieuw.";
  if (code === 429) return "Gmail-limiet bereikt. Probeer later opnieuw.";
  return "Gmail kon niet worden gecontroleerd. Probeer later opnieuw.";
}
