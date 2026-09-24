import { createHash } from "node:crypto";
import type { ExtractedItem, RadarCategory, RadarPriority, RadarStatus, SourceRef } from "./types";

export type ParsedMessage = {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
  bulk: boolean;
  attachmentNames: string[];
  sent?: boolean;
};

export type ParsedThread = { id: string; messages: ParsedMessage[] };
export type CalendarEventInput = {
  id: string;
  calendarId: string;
  title: string;
  description: string;
  start: string;
  end: string | null;
  updated: string;
  status: string;
  eventType: string;
  selfResponse: string | null;
  htmlLink: string | null;
  organizerEmail: string | null;
};

export type ExtractionDecision = {
  candidate: ExtractedItem | null;
  resolved: boolean;
  reason: string | null;
};

const actionVerbs = "sturen|aanleveren|invullen|controleren|bevestigen|ondertekenen|betalen|reageren|antwoorden|doorgeven|regelen|ophalen|inplannen|nakijken|meebrengen|retourneren|terugsturen|uploaden|aanmelden|goedkeuren|reviewen|versturen|aanpassen|terugbellen|afspreken";
const requestPatterns = [
  new RegExp(`\\b(?:kun|kan|wil|wilt|zou)\\s+(?:je|jij|u)\\b[^.!?\\n]{0,160}\\b(?:${actionVerbs})\\b`, "i"),
  new RegExp(`\\b(?:graag|please)\\s+(?:nog\\s+)?(?:je|uw|jouw)?\\s*(?:${actionVerbs})\\b`, "i"),
  /\b(?:laat|kun)\s+(?:je|u)\s+(?:mij|me|ons)\s+(?:weten|bevestigen)\b/i,
  /\b(?:ik|wij)\s+(?:ontvang|ontvangen)\s+graag\b/i,
  /\b(?:please|could you|can you|would you)\b[^.!?\n]{0,160}\b(?:send|confirm|sign|pay|review|reply|provide|submit|return|call)\b/i,
];
const promisePattern = /\b(?:ik|we|wij)\s+(?:zal|zullen|ga|gaan|stuur|regel|lever|kom(?:en)?\s+(?:er|hier)\s+op\s+terug)\b/i;
const completionPattern = /\b(?:ik|wij|we)\s+(?:heb|hebben)\b[^.!?\n]{0,120}\b(?:gestuurd|aangeleverd|ingevuld|bevestigd|ondertekend|betaald|geregeld|geüpload|verstuurd|afgerond|gedaan)\b|\b(?:ik|wij|we)\s+(?:stuur|sturen)\s+(?:je|u)?\s*(?:hierbij|bijgevoegd|nu)\b|\b(?:bijgevoegd|in de bijlage)\b/i;
const resolutionPattern = /\b(?:dank(?:jewel| je| u)?[,!]?\s*(?:ik\s+heb\s+het\s+)?ontvangen|het\s+is\s+(?:afgerond|opgelost|betaald|geleverd|terugbetaald)|betaling\s+(?:is\s+)?ontvangen|terugbetaling\s+(?:is\s+)?verwerkt|afspraak\s+(?:is\s+)?geannuleerd)\b/i;
const negationPattern = /\b(?:niet|nog\s+niet|geen)\b/i;
const prepPattern = /\b(?:bereid\s+(?:je|u)\s+voor|voorbereiden|neem\b[^.!?\n]{0,80}\bmee|meebrengen|graag\s+vooraf\s+(?:invullen|lezen|sturen)|please\s+bring|prepare\s+for)\b/i;
const monthNumber: Record<string, number> = {
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6,
  juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function clean(value: string, max = 240): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function visibleMessageBody(body: string): string {
  return body
    .split(/\n(?:Op .{5,100} schreef .+:|On .{5,100} wrote:|Van:\s|From:\s|_{8,}|--\s*$)/i)[0]
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .slice(0, 12_000);
}

function relevantSentence(text: string, pattern: RegExp): string | null {
  const fragments = text.split(/(?<=[.!?])\s+|\n+/).map((part) => clean(part, 300)).filter(Boolean);
  return fragments.find((fragment) => pattern.test(fragment)) || null;
}

function requestedSentence(text: string): string | null {
  for (const pattern of requestPatterns) {
    const sentence = relevantSentence(text, pattern);
    if (sentence) return sentence;
  }
  return null;
}

function categoryFor(text: string): RadarCategory {
  if (/\b(?:KVW|kindervakantiewerk)\b/i.test(text)) return "kvw";
  if (/\b(?:ASML|werkgever|salaris|arbeidscontract)\b/i.test(text)) return "werk";
  if (/\b(?:auto|APK|garage|kenteken|banden|autoverzekering)\b/i.test(text)) return "auto";
  if (/\b(?:woning|huis|hypotheek|VvE|verhuurder|dak|cv-ketel|meterkast)\b/i.test(text)) return "woning";
  if (/\b(?:bestelling|pakket|bezorg|retour|webshop|aankoop|terugbetaling)\b/i.test(text)) return "aankopen";
  if (/\b(?:bedrijf|startup|project|klant|offerte|prototype|AI)\b/i.test(text)) return "bedrijf";
  return "prive";
}

function deadlineFrom(text: string): string | null {
  const numeric = text.match(/\b(?:uiterlijk|voor|vóór|tegen)\s+(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/i);
  if (numeric) return validDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  const named = text.match(/\b(?:uiterlijk|voor|vóór|tegen)\s+(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})\b/i);
  if (named) return validDate(Number(named[3]), monthNumber[named[2].toLowerCase()], Number(named[1]));
  return null;
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : null;
}

function priorityFor(status: RadarStatus, dueAt: string | null): { priority: RadarPriority; reason: string } {
  if (dueAt) {
    const days = (Date.parse(dueAt.slice(0, 10) + "T00:00:00Z") - Date.now()) / 86_400_000;
    if (days < 0) return { priority: "hoog", reason: "Onderbouwde datum is verstreken; controleer de actuele status." };
    if (days <= 3) return { priority: "hoog", reason: "Onderbouwde datum binnen drie dagen." };
    return { priority: "normaal", reason: "Onderbouwde datum is bekend." };
  }
  if (status === "wachten_op_ander") return { priority: "laag", reason: "Een ander is aan zet; er is geen officiële deadline gevonden." };
  if (status === "controleren") return { priority: "laag", reason: "Eerst bevestigen of actie nodig is." };
  return { priority: "normaal", reason: "Concrete actie zonder onderbouwde deadline." };
}

function messageRef(threadId: string, subject: string): SourceRef {
  return { label: clean(subject || "Gmail-gesprek", 80), url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`, kind: "gmail" };
}

function counterpartForMail(message: ParsedMessage, accountEmail: string): string | null {
  const counterpartHeader = isOutgoing(message, accountEmail) ? message.to : message.from;
  const addresses = counterpartHeader.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return addresses.map((address) => address.toLowerCase()).find((address) => address !== accountEmail.toLowerCase()) || null;
}

function caseKeyForMail(subject: string, counterpart: string | null): string | null {
  const normalized = subject.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const words = normalized.split(/\s+/);
  const distinctive = (normalized.length >= 24 && words.length >= 4)
    || (/\b(?:order|bestelling|offerte|dossier|aanvraag|referentie|project)\b/.test(normalized) && /\b\d{4,}\b/.test(normalized));
  if (!distinctive) return null;
  return counterpart ? hash(`gmail-case:${counterpart}:${normalized}`) : null;
}

function isOutgoing(message: ParsedMessage, accountEmail: string): boolean {
  return Boolean(message.sent || message.from.toLowerCase().includes(accountEmail));
}

export function isExcludedGmailContent(message: ParsedMessage): boolean {
  if (process.env.INCLUDE_WORK_CONTENT === "true") return false;
  return /@asml\.com\b|\bASML\b|\b(?:client|klant|confidential|vertrouwelijk|NDA)\b/i.test(`${message.from} ${message.to} ${message.cc} ${message.subject} ${message.body}`);
}

export function isExcludedCalendarContent(event: CalendarEventInput): boolean {
  if (process.env.INCLUDE_WORK_CONTENT === "true") return false;
  return /@asml\.com\b|\bASML\b|\b(?:client|klant|confidential|vertrouwelijk|NDA)\b/i.test(`${event.title} ${event.description} ${event.organizerEmail || ""}`);
}

function isCalendarNotification(message: ParsedMessage): boolean {
  return /(?:calendar-notification@google\.com|calendar\.google\.com)/i.test(message.from)
    || message.attachmentNames.some((name) => /\.ics$/i.test(name))
    || /^(?:invitation|uitnodiging|updated invitation|bijgewerkte uitnodiging):/i.test(message.subject);
}

function makeMailCandidate(thread: ParsedThread, message: ParsedMessage, accountEmail: string, status: RadarStatus, summary: string, nextStep: string, uncertainty: string | null): ExtractedItem {
  const subject = clean(message.subject.replace(/^(?:(?:re|fw|fwd):\s*)+/i, ""), 100) || "Gmail-gesprek";
  const dueAt = deadlineFrom(`${message.subject} ${visibleMessageBody(message.body)}`);
  const { priority, reason } = priorityFor(status, dueAt);
  const titlePrefix = status === "wachten_op_ander" ? "Wacht op antwoord" : status === "controleren" ? "Controleer" : "Reageer op";
  const counterpart = counterpartForMail(message, accountEmail);
  const caseKey = caseKeyForMail(subject, counterpart);
  return {
    sourceKey: `gmail:thread:${thread.id}`,
    caseKey,
    relatedSearch: caseKey && counterpart ? { subject, counterpart } : null,
    fingerprint: hash(thread.messages.map(({ id, date, body }) => [id, date, body])),
    evidenceAt: message.date,
    title: clean(`${titlePrefix}: ${subject}`, 120),
    category: categoryFor(`${subject} ${message.body}`),
    status,
    owner: status === "wachten_op_ander" ? clean(message.to || "Ander", 100) : "Kenny",
    summary: clean(summary, 360),
    nextStep: clean(nextStep, 220),
    dueAt,
    suggestedFollowUpAt: null,
    priority,
    priorityReason: reason,
    sourceRefs: [messageRef(thread.id, subject)],
    waitingSince: status === "wachten_op_ander" ? message.date : null,
    uncertainty,
  };
}

export function extractGmailThread(thread: ParsedThread, accountEmail: string): ExtractionDecision {
  const messages = [...thread.messages].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (!messages.length) return { candidate: null, resolved: false, reason: null };
  if (messages.some(isExcludedGmailContent)) return { candidate: null, resolved: false, reason: null };
  const email = accountEmail.toLowerCase();
  const eligible = messages.filter((message) => !message.bulk && !isCalendarNotification(message));
  if (!eligible.length) return { candidate: null, resolved: false, reason: null };
  const latest = eligible.at(-1)!;
  const outgoing = isOutgoing(latest, email);
  const body = visibleMessageBody(latest.body);
  const directed = latest.to.toLowerCase().includes(email);
  const request = requestedSentence(body);

  if (resolutionPattern.test(body) && !negationPattern.test(body)) {
    return { candidate: null, resolved: true, reason: "In een later bericht is de afhandeling bevestigd." };
  }
  if (outgoing) {
    if (completionPattern.test(body) && !negationPattern.test(body)) {
      return { candidate: null, resolved: true, reason: "In een later verzonden bericht is uitvoering bevestigd." };
    }
    if (promisePattern.test(body)) {
      const sentence = relevantSentence(body, promisePattern) || body;
      return { candidate: makeMailCandidate(thread, latest, email, "actie_nodig", `Je hebt zelf toegezegd: “${clean(sentence, 220)}”`, "Voer je toezegging uit en controleer daarna de thread.", null), resolved: false, reason: null };
    }
    if (request || /\?/.test(body) && /\b(?:status|antwoord|reactie|update|wanneer|hoe staat)\b/i.test(body)) {
      const sentence = request || relevantSentence(body, /\?/) || body;
      return { candidate: makeMailCandidate(thread, latest, email, "wachten_op_ander", `Je hebt een antwoord gevraagd: “${clean(sentence, 220)}”`, "Wacht op antwoord; volg zelf op als dat nodig wordt.", null), resolved: false, reason: null };
    }
    const priorIncomingRequest = [...eligible].reverse().slice(1).find((message) => !isOutgoing(message, email) && requestedSentence(visibleMessageBody(message.body)));
    if (priorIncomingRequest) {
      return { candidate: makeMailCandidate(thread, latest, email, "controleren", "Je hebt op een verzoek geantwoord, maar de thread bevestigt niet dat de zaak daarmee is afgehandeld.", "Controleer of je antwoord het verzoek volledig heeft opgelost.", "Een verstuurd antwoord bewijst niet dat de hele zaak is afgerond."), resolved: false, reason: null };
    }
    return { candidate: null, resolved: false, reason: null };
  }

  if (!directed) return { candidate: null, resolved: false, reason: null };
  if (request) {
    const attachmentNote = latest.attachmentNames.length ? " Bijlagen zijn niet inhoudelijk gecontroleerd." : "";
    const priorOutgoingCompletion = [...eligible].reverse().slice(1).find((message) => isOutgoing(message, email) && completionPattern.test(visibleMessageBody(message.body)));
    if (priorOutgoingCompletion && !/\b(?:opnieuw|alsnog|nogmaals|again)\b/i.test(body)) {
      return { candidate: makeMailCandidate(thread, latest, email, "controleren", `Nieuw verzoek na een eerder gemelde uitvoering: “${clean(request, 220)}”`, "Controleer of dit een nieuw verzoek is of dezelfde al afgeronde zaak.", "Een eerdere uitvoering is gemeld; de nieuwe vraag kan een vervolg zijn."), resolved: false, reason: null };
    }
    return { candidate: makeMailCandidate(thread, latest, email, "actie_nodig", `Er is een concreet verzoek aan jou: “${clean(request, 220)}”${attachmentNote}`, clean(request, 200), latest.attachmentNames.length ? "Bijlagen zijn niet inhoudelijk gecontroleerd." : null), resolved: false, reason: null };
  }
  if (/\b(?:factuur|betalingsverzoek)\b/i.test(`${latest.subject} ${body}`) && /\b(?:betaalgegevens|betaalverzoek|betalingsverzoek|betaling|vervaldatum|uiterlijk)\b/i.test(body)) {
    return { candidate: makeMailCandidate(thread, latest, email, "controleren", "Er is een betalingsverzoek gevonden, maar uit de gecontroleerde thread blijkt niet of het al is betaald.", "Controleer de betaalstatus voordat je iets betaalt.", "Geen betaalbevestiging in de gecontroleerde thread; andere betaalbronnen zijn niet doorzocht."), resolved: false, reason: null };
  }
  return { candidate: null, resolved: false, reason: null };
}

export function extractCalendarEvent(event: CalendarEventInput, accountEmail: string): ExtractionDecision {
  if (isExcludedCalendarContent(event)) return { candidate: null, resolved: false, reason: null };
  if (event.status === "cancelled" || event.selfResponse === "declined") {
    return { candidate: null, resolved: true, reason: "De afspraak is geannuleerd of afgewezen." };
  }
  if (event.eventType && event.eventType !== "default") return { candidate: null, resolved: false, reason: null };
  const startMs = Date.parse(event.start);
  if (!Number.isFinite(startMs)) {
    return { candidate: null, resolved: false, reason: null };
  }
  const description = clean(event.description, 400);
  const invite = event.selfResponse === "needsAction";
  const prep = prepPattern.test(event.description);
  const past = startMs < Date.now() - 86_400_000;
  if (past && !invite && !prep) return { candidate: null, resolved: true, reason: "De afspraakdatum is verstreken." };
  const status: RadarStatus = past ? "controleren" : invite || prep ? "actie_nodig" : "gepland";
  const { priority, reason } = priorityFor(status, event.start);
  const title = clean(event.title || "Afspraak", 120);
  const prepSentence = prep ? relevantSentence(event.description, prepPattern) : null;
  const nextStep = past ? "Controleer of deze afspraak of voorbereiding nog opvolging vraagt." : invite ? "Reageer op de uitnodiging in Google Agenda." : prepSentence ? clean(prepSentence, 220) : "Bekijk de afspraak in Google Agenda.";
  const note = past ? "De afspraakdatum is verstreken; eerdere reactie of voorbereiding was mogelijk nog open." : invite ? "Je reactie op de uitnodiging staat nog open." : prep ? `Voorbereiding genoemd: “${clean(prepSentence || "", 180)}”` : "Aankomende afspraak; geen aparte voorbereidingsactie gevonden.";
  const calendarRefs: SourceRef[] = event.htmlLink ? [{ label: title, url: event.htmlLink, kind: "calendar" }] : [];
  return {
    candidate: {
      sourceKey: `calendar:${event.calendarId}:${event.id}`,
      caseKey: null,
      fingerprint: hash([event.id, event.updated, event.status, event.selfResponse, event.title, event.description, event.start]),
      evidenceAt: event.updated || event.start,
      title,
      category: categoryFor(`${event.title} ${event.description}`),
      status,
      owner: invite || prep ? "Kenny" : event.organizerEmail || accountEmail,
      summary: note,
      nextStep,
      dueAt: event.start,
      suggestedFollowUpAt: null,
      priority,
      priorityReason: reason,
      sourceRefs: calendarRefs,
      waitingSince: null,
      uncertainty: [past ? "Niet bevestigd of de voorbereiding of reactie is afgehandeld." : null, event.htmlLink ? null : "Google Agenda gaf geen directe link naar deze afspraak terug."].filter(Boolean).join(" ") || null,
    },
    resolved: false,
    reason: null,
  };
}
