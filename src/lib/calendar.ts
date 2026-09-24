import { google, type calendar_v3 } from "googleapis";
import { extractCalendarEvent, isExcludedCalendarContent, type CalendarEventInput } from "./extraction";
import { getGoogleClient, GOOGLE_SCOPES } from "./google";
import { getItemBySourceKey, meta, resolveSourceKey, setMeta, setSourceCheck, setSourceConnection, upsertExtracted } from "./db";
import type { ScanResponse } from "./types";

type ChangeDetails = ScanResponse["changes"]["details"];

function toInput(event: calendar_v3.Schema$Event, calendarId: string, email: string): CalendarEventInput | null {
  if (!event.id) return null;
  const self = event.attendees?.find((attendee) => attendee.self || attendee.email?.toLowerCase() === email.toLowerCase());
  return {
    id: event.id,
    calendarId,
    title: event.summary || "Afspraak",
    description: event.description || "",
    start: event.start?.dateTime || event.start?.date || "",
    end: event.end?.dateTime || event.end?.date || null,
    updated: event.updated || event.created || new Date().toISOString(),
    status: event.status || "confirmed",
    eventType: event.eventType || "default",
    selfResponse: self?.responseStatus || null,
    htmlLink: event.htmlLink || null,
    organizerEmail: event.organizer?.email || null,
  };
}

export async function scanCalendar(checkedAt: string, changes: ChangeDetails): Promise<void> {
  const client = getGoogleClient();
  const windowStart = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const windowEnd = new Date(Date.now() + 90 * 86_400_000).toISOString();
  if (!client || !client.scopes.includes(GOOGLE_SCOPES[3]) || !client.scopes.includes(GOOGLE_SCOPES[4])) {
    setSourceConnection("calendar", false, "Google Agenda is niet aangesloten met leestoegang.");
    return;
  }
  const calendar = google.calendar({ version: "v3", auth: client.oauth });
  const lastCheckedAt = meta("calendar_last_checked_at");
  const updatedMin = lastCheckedAt ? new Date(Date.parse(lastCheckedAt) - 120_000).toISOString() : null;
  const calendars: calendar_v3.Schema$CalendarListEntry[] = [];
  try {
    let nextPage: string | undefined;
    do {
      const response = await calendar.calendarList.list({ maxResults: 250, pageToken: nextPage });
      calendars.push(...(response.data.items || []));
      nextPage = response.data.nextPageToken || undefined;
    } while (nextPage);
  } catch (error) {
    setSourceCheck({ id: "calendar", lastCheckedAt: checkedAt, searchWindowStart: windowStart, searchWindowEnd: windowEnd, result: "mislukt", note: friendlyCalendarError(error) });
    return;
  }

  let scanned = 0;
  let skipped = 0;
  let sensitiveSkipped = 0;
  let missingDirectLink = 0;
  const failures: string[] = [];
  for (const entry of calendars) {
    if (!entry.id || entry.accessRole === "freeBusyReader") { skipped++; continue; }
    try {
      let nextPage: string | undefined;
      do {
        const response = await calendar.events.list({
          calendarId: entry.id,
          maxResults: 250,
          pageToken: nextPage,
          singleEvents: true,
          showDeleted: true,
          ...(updatedMin ? { updatedMin } : { timeMin: windowStart, timeMax: windowEnd }),
        });
        for (const event of response.data.items || []) {
          const input = toInput(event, entry.id, client.email);
          if (!input) continue;
          if (isExcludedCalendarContent(input)) { sensitiveSkipped++; continue; }
          if (!input.htmlLink && input.status !== "cancelled") missingDirectLink++;
          scanned++;
          const sourceKey = `calendar:${entry.id}:${input.id}`;
          const decision = extractCalendarEvent(input, client.email);
          if (decision.candidate) {
            const change = upsertExtracted(decision.candidate, checkedAt);
            if (change !== "unchanged") {
              const item = getItemBySourceKey(sourceKey);
              if (item) changes[change].push({ id: item.id, title: item.title });
            }
          } else if (decision.resolved && resolveSourceKey(sourceKey, checkedAt, decision.reason || "Afspraak gewijzigd.")) {
            const item = getItemBySourceKey(sourceKey);
            if (item) changes[item.status === "afgerond" ? "resolved" : "updated"].push({ id: item.id, title: item.title });
          }
        }
        nextPage = response.data.nextPageToken || undefined;
      } while (nextPage);
    } catch {
      failures.push(entry.summary || entry.id);
    }
  }
  if (!failures.length) setMeta("calendar_last_checked_at", checkedAt);
  const result = failures.length ? scanned > 0 ? "gedeeltelijk" : "mislukt" : skipped || sensitiveSkipped || missingDirectLink ? "gedeeltelijk" : "volledig";
  const note = failures.length
    ? `${failures.length} agenda’s konden niet worden gecontroleerd; deze worden bij de volgende scan opnieuw geprobeerd.`
    : `${scanned} ${updatedMin ? "gewijzigde" : "aankomende"} afspraken in ${calendars.length - skipped} agenda’s gecontroleerd.${skipped ? ` ${skipped} agenda’s zonder leesbare evenementdetails overgeslagen.` : ""}${sensitiveSkipped ? ` ${sensitiveSkipped} mogelijke werk- of cliëntafspraken buiten verwerking gehouden.` : ""}${missingDirectLink ? ` ${missingDirectLink} afspraken zonder directe bronlink.` : ""}`;
  setSourceCheck({ id: "calendar", lastCheckedAt: checkedAt, searchWindowStart: updatedMin || windowStart, searchWindowEnd: windowEnd, result, note });
}

function friendlyCalendarError(error: unknown): string {
  const code = (error as { code?: number }).code;
  if (code === 401 || code === 403) return "Agenda-toegang geweigerd of verlopen. Koppel Google opnieuw.";
  if (code === 429) return "Agenda-limiet bereikt. Probeer later opnieuw.";
  return "Google Agenda kon niet worden gecontroleerd. Probeer later opnieuw.";
}
