import { acquireScan, finishScan, getDashboard, retirePastAppointments } from "./db";
import { scanGmail } from "./gmail";
import { scanCalendar } from "./calendar";
import type { ScanResponse } from "./types";

export class ScanAlreadyRunningError extends Error {}

function uniqueChanges(details: ScanResponse["changes"]["details"]): ScanResponse["changes"] {
  const unique = (items: { id: string; title: string }[]) => [...new Map(items.map((item) => [item.id, item])).values()];
  const created = unique(details.created);
  const createdIds = new Set(created.map((item) => item.id));
  const updated = unique(details.updated).filter((item) => !createdIds.has(item.id));
  const resolved = unique(details.resolved).filter((item) => !createdIds.has(item.id));
  return { created: created.length, updated: updated.length, resolved: resolved.length, details: { created, updated, resolved } };
}

export async function runScan(): Promise<ScanResponse> {
  if (!acquireScan()) throw new ScanAlreadyRunningError("Een controle loopt al.");
  const checkedAt = new Date().toISOString();
  const details: ScanResponse["changes"]["details"] = { created: [], updated: [], resolved: [] };
  let fatal: string | null = null;
  try {
    // Each click scans several pages, while a saved cursor keeps larger mailboxes resumable.
    for (let page = 0; page < 3; page++) {
      const hasMore = await scanGmail(checkedAt, details);
      if (!hasMore) break;
    }
    await scanCalendar(checkedAt, details);
    const retired = retirePastAppointments(checkedAt);
    details.resolved.push(...retired.resolved);
    details.updated.push(...retired.updated);
    const attempted = getDashboard().sources.filter((source) => source.connected);
    if (!attempted.length || attempted.every((source) => source.result === "mislukt" || source.result === "nooit")) {
      fatal = "Geen aangesloten bron kon worden gecontroleerd. Bekijk de status per bron.";
    }
  } catch {
    fatal = "De broncontrole is onverwacht gestopt. Probeer het opnieuw.";
  } finally {
    finishScan(fatal);
  }
  const dashboard = getDashboard();
  return { ...dashboard, changes: uniqueChanges(details) };
}
