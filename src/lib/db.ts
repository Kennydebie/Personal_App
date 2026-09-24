import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getConfig } from "./config";
import type { DashboardResponse, ExtractedItem, RadarItem, SourceState } from "./types";

type ItemRow = {
  id: string;
  source_key: string;
  case_key: string | null;
  title: string;
  category: RadarItem["category"];
  status: RadarItem["status"];
  owner: string;
  summary: string;
  next_step: string;
  due_at: string | null;
  suggested_follow_up_at: string | null;
  priority: RadarItem["priority"];
  priority_reason: string;
  source_refs: string;
  last_checked_at: string;
  waiting_since: string | null;
  uncertainty: string | null;
  snoozed_until: string | null;
  manual: number;
  manual_at: string | null;
  fingerprint: string;
  evidence_at: string;
  updated_at: string;
};

type SourceRow = {
  id: SourceState["id"];
  name: string;
  connected: number;
  last_checked_at: string | null;
  window_start: string | null;
  window_end: string | null;
  result: SourceState["result"];
  note: string | null;
};

let cached: DatabaseSync | null = null;

export class DatabaseOwnerMismatchError extends Error {}

function ensureOwner(db: DatabaseSync): void {
  const owner = db.prepare("SELECT value FROM meta WHERE key='owner_email'").get() as { value: string } | undefined;
  const allowed = getConfig().allowedEmail;
  if (owner?.value && owner.value !== allowed) throw new DatabaseOwnerMismatchError("Database belongs to another account");
  if (owner) return;
  const existing = db.prepare("SELECT email FROM credentials WHERE id=1").get() as { email: string } | undefined;
  if (existing && existing.email !== allowed) throw new DatabaseOwnerMismatchError("Database belongs to another account");
  const itemCount = db.prepare("SELECT count(*) AS count FROM items").get() as { count: number };
  if (!existing && itemCount.count > 0) throw new DatabaseOwnerMismatchError("Existing data has no owner binding");
  db.prepare("INSERT INTO meta(key,value) VALUES ('owner_email',?)").run(allowed);
}

export function database(): DatabaseSync {
  if (cached) { ensureOwner(cached); return cached; }
  const file = getConfig().databasePath;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email TEXT NOT NULL,
      scopes TEXT NOT NULL,
      encrypted_tokens TEXT NOT NULL,
      connected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connected INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      window_start TEXT,
      window_end TEXT,
      result TEXT NOT NULL DEFAULT 'nooit',
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      case_key TEXT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      owner TEXT NOT NULL,
      summary TEXT NOT NULL,
      next_step TEXT NOT NULL,
      due_at TEXT,
      suggested_follow_up_at TEXT,
      priority TEXT NOT NULL,
      priority_reason TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,
      waiting_since TEXT,
      uncertainty TEXT,
      snoozed_until TEXT,
      manual INTEGER NOT NULL DEFAULT 0,
      manual_at TEXT,
      fingerprint TEXT NOT NULL,
      evidence_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO sources (id, name) VALUES ('gmail', 'Gmail'), ('calendar', 'Google Agenda');
  `);
  const itemColumns = db.prepare("PRAGMA table_info(items)").all() as { name: string }[];
  if (!itemColumns.some((column) => column.name === "case_key")) db.exec("ALTER TABLE items ADD COLUMN case_key TEXT;");
  db.exec(`
    CREATE INDEX IF NOT EXISTS items_case_key_idx ON items(case_key);
    CREATE TABLE IF NOT EXISTS item_sources (
      source_key TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      evidence_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS item_sources_item_idx ON item_sources(item_id);
    INSERT OR IGNORE INTO item_sources (source_key,item_id,fingerprint,evidence_at)
      SELECT source_key,id,fingerprint,evidence_at FROM items;
  `);
  const sourceColumns = db.prepare("PRAGMA table_info(item_sources)").all() as { name: string }[];
  if (!sourceColumns.some((column) => column.name === "resolved")) db.exec("ALTER TABLE item_sources ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0;");
  ensureOwner(db);
  cached = db;
  return db;
}

export function meta(key: string): string | null {
  const row = database().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string | null): void {
  if (value === null) database().prepare("DELETE FROM meta WHERE key = ?").run(key);
  else database().prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getCredential(): { email: string; scopes: string[]; encryptedTokens: string } | null {
  const row = database().prepare("SELECT email, scopes, encrypted_tokens FROM credentials WHERE id = 1").get() as
    | { email: string; scopes: string; encrypted_tokens: string }
    | undefined;
  return row ? { email: row.email, scopes: JSON.parse(row.scopes) as string[], encryptedTokens: row.encrypted_tokens } : null;
}

export function saveCredential(email: string, scopes: string[], encryptedTokens: string): void {
  database()
    .prepare("INSERT INTO credentials (id,email,scopes,encrypted_tokens,connected_at) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email, scopes=excluded.scopes, encrypted_tokens=excluded.encrypted_tokens, connected_at=excluded.connected_at")
    .run(email, JSON.stringify(scopes), encryptedTokens, new Date().toISOString());
}

export function clearCredential(): void {
  const db = database();
  db.prepare("DELETE FROM credentials").run();
  db.prepare("UPDATE sources SET connected=0, note='Bron losgekoppeld.'").run();
  for (const key of ["gmail_history_id", "gmail_initial_anchor", "gmail_initial_page", "gmail_initial_window_start", "gmail_history_page", "gmail_history_base", "gmail_attachment_unreviewed", "gmail_sensitive_skipped", "gmail_older_pending", "gmail_older_scan_at", "calendar_last_checked_at"]) setMeta(key, null);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
}

export function setSourceConnection(id: SourceState["id"], connected: boolean, note: string | null = null): void {
  database().prepare("UPDATE sources SET connected=?, note=? WHERE id=?").run(connected ? 1 : 0, note, id);
}

export function setSourceCheck(source: Omit<SourceState, "name" | "connected">): void {
  if (source.result === "mislukt") {
    database().prepare("UPDATE sources SET result=?, note=? WHERE id=?").run(source.result, source.note, source.id);
    return;
  }
  database()
    .prepare("UPDATE sources SET last_checked_at=?, window_start=?, window_end=?, result=?, note=? WHERE id=?")
    .run(source.lastCheckedAt, source.searchWindowStart, source.searchWindowEnd, source.result, source.note, source.id);
}

export function markSourceUnavailable(sourceKey: string, checkedAt: string): boolean {
  const db = database();
  const old = rowBySourceKey(db, sourceKey);
  if (!old || old.manual || old.status === "genegeerd" || old.status === "afgerond"
    || old.status === "controleren" && old.uncertainty?.startsWith("De oorspronkelijke bron is niet meer bereikbaar")) return false;
  db.prepare("UPDATE items SET status='controleren', uncertainty=?, next_step=?, last_checked_at=?, updated_at=? WHERE id=?")
    .run("De oorspronkelijke bron is niet meer bereikbaar; daardoor kan de afhandeling niet worden vastgesteld.", "Controleer zelf of deze zaak nog openstaat.", checkedAt, checkedAt, old.id);
  return true;
}

function itemFromRow(row: ItemRow): RadarItem {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    status: row.status,
    owner: row.owner,
    summary: row.summary,
    nextStep: row.next_step,
    dueAt: row.due_at,
    suggestedFollowUpAt: row.suggested_follow_up_at,
    priority: row.priority,
    priorityReason: row.priority_reason,
    sourceRefs: JSON.parse(row.source_refs) as RadarItem["sourceRefs"],
    lastCheckedAt: row.last_checked_at,
    waitingSince: row.waiting_since,
    uncertainty: row.uncertainty,
    snoozedUntil: row.snoozed_until,
    manual: Boolean(row.manual),
  };
}

export function getItem(id: string): RadarItem | null {
  const row = database().prepare("SELECT * FROM items WHERE id=?").get(id) as ItemRow | undefined;
  return row ? itemFromRow(row) : null;
}

export function getItemBySourceKey(sourceKey: string): RadarItem | null {
  const row = rowBySourceKey(database(), sourceKey);
  return row ? itemFromRow(row) : null;
}

function rowBySourceKey(db: DatabaseSync, sourceKey: string): ItemRow | undefined {
  return db.prepare("SELECT items.* FROM items JOIN item_sources ON item_sources.item_id=items.id WHERE item_sources.source_key=?").get(sourceKey) as ItemRow | undefined;
}

function mergedRefs(oldRefs: string, newRefs: RadarItem["sourceRefs"]): RadarItem["sourceRefs"] {
  const all = [...(JSON.parse(oldRefs) as RadarItem["sourceRefs"]), ...newRefs];
  return [...new Map(all.map((ref) => [ref.url, ref])).values()];
}

export function getDashboard(): DashboardResponse {
  const db = database();
  const credential = getCredential();
  const rows = db.prepare("SELECT * FROM sources ORDER BY CASE id WHEN 'gmail' THEN 0 ELSE 1 END").all() as SourceRow[];
  const sources = rows.map((row): SourceState => ({
    id: row.id,
    name: row.name,
    connected: Boolean(row.connected && credential),
    lastCheckedAt: row.last_checked_at,
    searchWindowStart: row.window_start,
    searchWindowEnd: row.window_end,
    result: row.result,
    note: row.note,
  }));
  const items = (db.prepare("SELECT * FROM items ORDER BY CASE priority WHEN 'hoog' THEN 0 WHEN 'normaal' THEN 1 ELSE 2 END, COALESCE(due_at, '9999-12-31'), updated_at DESC").all() as ItemRow[]).map(itemFromRow);
  const started = meta("scan_started_at");
  const running = started && Date.now() - Date.parse(started) < 15 * 60_000;
  return {
    items,
    sources,
    lastUpdatedAt: meta("last_updated_at"),
    scanState: running ? "running" : meta("last_scan_error") ? "error" : "idle",
    lastScanError: meta("last_scan_error"),
  };
}

export function acquireScan(): boolean {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const started = meta("scan_started_at");
    if (started && Date.now() - Date.parse(started) < 15 * 60_000) {
      db.exec("ROLLBACK");
      return false;
    }
    setMeta("scan_started_at", new Date().toISOString());
    setMeta("last_scan_error", null);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function finishScan(error: string | null): void {
  setMeta("scan_started_at", null);
  setMeta("last_scan_error", error);
  if (!error) setMeta("last_updated_at", new Date().toISOString());
}

export function upsertExtracted(candidate: ExtractedItem, checkedAt: string): "created" | "updated" | "unchanged" {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const source = db.prepare("SELECT item_id,fingerprint FROM item_sources WHERE source_key=?").get(candidate.sourceKey) as { item_id: string; fingerprint: string } | undefined;
    let old = source ? db.prepare("SELECT * FROM items WHERE id=?").get(source.item_id) as ItemRow | undefined : undefined;
    if (!old && candidate.caseKey) {
      // Same counterpart and sufficiently specific subject; keep recurring cases apart.
      old = db.prepare("SELECT * FROM items WHERE case_key=? AND abs(julianday(evidence_at)-julianday(?)) <= 45 ORDER BY evidence_at DESC LIMIT 1")
        .get(candidate.caseKey, candidate.evidenceAt) as ItemRow | undefined;
    }
    if (!old) {
      const id = randomUUID();
      db.prepare(`INSERT INTO items (id,source_key,case_key,title,category,status,owner,summary,next_step,due_at,suggested_follow_up_at,priority,priority_reason,source_refs,last_checked_at,waiting_since,uncertainty,snoozed_until,manual,manual_at,fingerprint,evidence_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,0,NULL,?,?,?,?)`)
        .run(id, candidate.sourceKey, candidate.caseKey, candidate.title, candidate.category, candidate.status, candidate.owner, candidate.summary, candidate.nextStep, candidate.dueAt, candidate.suggestedFollowUpAt, candidate.priority, candidate.priorityReason, JSON.stringify(candidate.sourceRefs), checkedAt, candidate.waitingSince, candidate.uncertainty, candidate.fingerprint, candidate.evidenceAt, checkedAt, checkedAt);
      db.prepare("INSERT INTO item_sources(source_key,item_id,fingerprint,evidence_at) VALUES (?,?,?,?)").run(candidate.sourceKey, id, candidate.fingerprint, candidate.evidenceAt);
      db.exec("COMMIT");
      return "created";
    }

    const newSource = !source;
    if (newSource) db.prepare("INSERT INTO item_sources(source_key,item_id,fingerprint,evidence_at) VALUES (?,?,?,?)")
      .run(candidate.sourceKey, old.id, candidate.fingerprint, candidate.evidenceAt);
    else if (source.fingerprint !== candidate.fingerprint) db.prepare("UPDATE item_sources SET fingerprint=?,evidence_at=?,resolved=0 WHERE source_key=?")
      .run(candidate.fingerprint, candidate.evidenceAt, candidate.sourceKey);
    const refs = mergedRefs(old.source_refs, candidate.sourceRefs);
    const refsChanged = refs.length !== (JSON.parse(old.source_refs) as RadarItem["sourceRefs"]).length;
    if (!newSource && source.fingerprint === candidate.fingerprint) {
      db.prepare("UPDATE items SET last_checked_at=? WHERE id=?").run(checkedAt, old.id);
      db.exec("COMMIT");
      return "unchanged";
    }
    const newer = Date.parse(candidate.evidenceAt) >= Date.parse(old.evidence_at);
    const newEvidenceAfterManualCompletion = old.status === "afgerond" && old.manual_at && Date.parse(candidate.evidenceAt) > Date.parse(old.manual_at);
    if (old.status === "genegeerd" || old.manual && !newEvidenceAfterManualCompletion || !newer) {
      db.prepare("UPDATE items SET source_refs=?,last_checked_at=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(refs), checkedAt, refsChanged ? checkedAt : old.updated_at, old.id);
      db.exec("COMMIT");
      return refsChanged ? "updated" : "unchanged";
    }
    const summary = newEvidenceAfterManualCompletion ? `Na je afronding is nieuwe informatie gevonden. ${candidate.summary}` : candidate.summary;
    db.prepare(`UPDATE items SET case_key=COALESCE(case_key,?),title=?,category=?,status=?,owner=?,summary=?,next_step=?,due_at=?,suggested_follow_up_at=?,priority=?,priority_reason=?,source_refs=?,last_checked_at=?,waiting_since=?,uncertainty=?,manual=0,manual_at=NULL,fingerprint=?,evidence_at=?,updated_at=? WHERE id=?`)
      .run(candidate.caseKey, candidate.title, candidate.category, candidate.status, candidate.owner, summary, candidate.nextStep, candidate.dueAt, candidate.suggestedFollowUpAt, candidate.priority, candidate.priorityReason, JSON.stringify(refs), checkedAt, candidate.waitingSince, candidate.uncertainty, candidate.fingerprint, candidate.evidenceAt, checkedAt, old.id);
    db.exec("COMMIT");
    return "updated";
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function resolveSourceKey(sourceKey: string, checkedAt: string, reason: string): boolean {
  const db = database();
  const old = rowBySourceKey(db, sourceKey);
  if (!old || old.manual || old.status === "afgerond" || old.status === "genegeerd") return false;
  db.prepare("UPDATE item_sources SET resolved=1 WHERE source_key=?").run(sourceKey);
  const unresolved = db.prepare("SELECT count(*) AS count FROM item_sources WHERE item_id=? AND resolved=0").get(old.id) as { count: number };
  if (unresolved.count > 0) {
    if (old.status === "controleren" && old.uncertainty?.startsWith("Een gerelateerde thread is afgehandeld")) return false;
    db.prepare("UPDATE items SET status='controleren', uncertainty=?, next_step=?, last_checked_at=?, updated_at=? WHERE id=?")
      .run("Een gerelateerde thread is afgehandeld; de andere bron is nog niet duidelijk afgesloten.", "Controleer alle gekoppelde bronberichten voordat je dit afrondt.", checkedAt, checkedAt, old.id);
    return true;
  }
  db.prepare("UPDATE items SET status='afgerond', summary=?, last_checked_at=?, updated_at=? WHERE id=?")
    .run(reason, checkedAt, checkedAt, old.id);
  return true;
}

export function retirePastAppointments(checkedAt: string): { resolved: { id: string; title: string }[]; updated: { id: string; title: string }[] } {
  const db = database();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const resolved = db.prepare("SELECT id,title FROM items WHERE source_key LIKE 'calendar:%' AND manual=0 AND status='gepland' AND substr(due_at,1,10) < ?").all(today) as { id: string; title: string }[];
  const updated = db.prepare("SELECT id,title FROM items WHERE source_key LIKE 'calendar:%' AND manual=0 AND status='actie_nodig' AND substr(due_at,1,10) < ?").all(today) as { id: string; title: string }[];
  if (resolved.length) {
    db.prepare("UPDATE items SET status='afgerond', summary='De afspraakdatum is verstreken.', last_checked_at=?, updated_at=? WHERE source_key LIKE 'calendar:%' AND manual=0 AND status='gepland' AND substr(due_at,1,10) < ?")
      .run(checkedAt, checkedAt, today);
  }
  if (updated.length) {
    db.prepare("UPDATE items SET status='controleren', uncertainty='De afspraakdatum is verstreken; of de voorbereiding of reactie alsnog nodig is, is niet bevestigd.', next_step='Controleer of deze afspraak of voorbereiding nog opvolging vraagt.', last_checked_at=?, updated_at=? WHERE source_key LIKE 'calendar:%' AND manual=0 AND status='actie_nodig' AND substr(due_at,1,10) < ?")
      .run(checkedAt, checkedAt, today);
  }
  return { resolved, updated };
}

export type ItemPatch = {
  status?: RadarItem["status"];
  snoozedUntil?: string | null;
  correction?: Partial<Pick<RadarItem, "title" | "summary" | "nextStep" | "owner" | "category" | "dueAt">>;
};

export function patchItem(id: string, patch: ItemPatch): RadarItem | null {
  const db = database();
  const row = db.prepare("SELECT * FROM items WHERE id=?").get(id) as ItemRow | undefined;
  if (!row) return null;
  const now = new Date().toISOString();
  const correction = patch.correction || {};
  const entries: [string, string | null | number][] = [];
  if (patch.status !== undefined) entries.push(["status", patch.status]);
  if (patch.status === "wachten_op_ander") entries.push(["waiting_since", row.waiting_since || now]);
  else if (patch.status !== undefined) entries.push(["waiting_since", null]);
  if (patch.snoozedUntil !== undefined) entries.push(["snoozed_until", patch.snoozedUntil]);
  for (const [from, to] of [["title", "title"], ["summary", "summary"], ["nextStep", "next_step"], ["owner", "owner"], ["category", "category"], ["dueAt", "due_at"]] as const) {
    if (correction[from] !== undefined) entries.push([to, correction[from] as string | null]);
  }
  if (!entries.length) return itemFromRow(row);
  entries.push(["manual", 1], ["manual_at", now], ["updated_at", now]);
  db.prepare(`UPDATE items SET ${entries.map(([column]) => `${column}=?`).join(",")} WHERE id=?`).run(...entries.map(([, value]) => value), id);
  return getItem(id);
}

export function deleteAllData(): void {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM item_sources; DELETE FROM items; DELETE FROM credentials; DELETE FROM meta; UPDATE sources SET connected=0,last_checked_at=NULL,window_start=NULL,window_end=NULL,result='nooit',note=NULL;");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
}
