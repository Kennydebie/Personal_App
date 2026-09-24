'use client';

import {
  AlarmClock,
  ArrowRight,
  ArrowUpRight,
  Ban,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  Clock3,
  Copy,
  ExternalLink,
  Inbox,
  LockKeyhole,
  LogOut,
  Mail,
  MessageSquareText,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  SquarePen,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { DashboardResponse, RadarItem, ScanResponse, SourceState } from '@/lib/types';

type AuthStatus = {
  authenticated: boolean;
  connected: boolean;
  loginUrl: string;
  setupIssues: string[];
};

type Draft = { subject: string; body: string; disclaimer: string };
type Modal =
  | { kind: 'snooze'; item: RadarItem }
  | { kind: 'correct'; item: RadarItem }
  | { kind: 'draft'; item: RadarItem; draft: Draft }
  | { kind: 'delete' };

const categories: { value: RadarItem['category']; label: string }[] = [
  { value: 'prive', label: 'Privé' },
  { value: 'woning', label: 'Woning' },
  { value: 'auto', label: 'Auto' },
  { value: 'aankopen', label: 'Aankopen' },
  { value: 'werk', label: 'Werk' },
  { value: 'bedrijf', label: 'Eigen bedrijf / projecten' },
  { value: 'kvw', label: 'KVW' },
];

const statuses: { value: RadarItem['status']; label: string }[] = [
  { value: 'actie_nodig', label: 'Actie nodig' },
  { value: 'wachten_op_ander', label: 'Wachten op ander' },
  { value: 'gepland', label: 'Gepland' },
  { value: 'controleren', label: 'Even controleren' },
  { value: 'afgerond', label: 'Afgerond' },
  { value: 'genegeerd', label: 'Niet relevant' },
];

const categoryName = (value: RadarItem['category']) =>
  categories.find((category) => category.value === value)?.label ?? value;
const statusName = (value: RadarItem['status']) =>
  statuses.find((status) => status.value === value)?.label ?? value;

function dateLabel(value: string | null | undefined, includeTime = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

function todayInAmsterdam() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (part: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === part)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function dateInputValue(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const valueFor = (part: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === part)?.value ?? '';
  return `${valueFor('year')}-${valueFor('month')}-${valueFor('day')}`;
}

function safeSourceUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function isSnoozed(item: RadarItem) {
  return Boolean(item.snoozedUntil && dateInputValue(item.snoozedUntil) > todayInAmsterdam());
}

function sortByAttention(items: RadarItem[]) {
  const priority: Record<RadarItem['priority'], number> = { hoog: 0, normaal: 1, laag: 2 };
  return items.slice().sort((a, b) => {
    const byPriority = priority[a.priority] - priority[b.priority];
    if (byPriority) return byPriority;
    const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
    const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
    return aDue - bDue;
  });
}

function sortByDate(items: RadarItem[]) {
  return items.slice().sort((a, b) => {
    const aDate = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
    const bDate = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
    return aDate - bDate;
  });
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Verzoek mislukt (${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}

export function Dashboard() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [workingItem, setWorkingItem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanChanges, setScanChanges] = useState<ScanResponse['changes'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try {
      setError(null);
      const authResponse = await fetch('/api/auth/status', { cache: 'no-store' });
      const nextAuth = await responseJson<AuthStatus>(authResponse);
      setAuth(nextAuth);
      if (nextAuth.authenticated) {
        const dashboardResponse = await fetch('/api/dashboard', { cache: 'no-store' });
        setData(await responseJson<DashboardResponse>(dashboardResponse));
      } else {
        setData(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Het overzicht kon niet worden geladen.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const authError = url.searchParams.get('auth_error');
    if (!authError) return;
    setError('Inloggen met Google is niet gelukt. Controleer de toegang en probeer opnieuw.');
    url.searchParams.delete('auth_error');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    if (data?.scanState !== 'running') return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [data?.scanState, load]);

  const items = data?.items ?? [];
  const connected = data?.sources.some((source) => source.connected) ?? auth?.connected ?? false;
  const scanInProgress = scanning || data?.scanState === 'running';
  const hasScanned = Boolean(data?.lastUpdatedAt);
  const activeItems = items.filter((item) => item.status !== 'afgerond' && item.status !== 'genegeerd');
  const dueNowAll = sortByAttention(activeItems.filter((item) => item.status === 'actie_nodig' && !isSnoozed(item)));
  const dueNow = dueNowAll.slice(0, 5);
  const upcomingAll = sortByDate(activeItems.filter((item) => !isSnoozed(item) && (item.status === 'gepland' || item.status === 'actie_nodig') && (!item.dueAt ? item.status === 'gepland' : dateInputValue(item.dueAt) >= todayInAmsterdam())));
  const upcoming = upcomingAll.slice(0, 4);
  const waitingAll = activeItems.filter((item) => item.status === 'wachten_op_ander' && !isSnoozed(item)).sort((a, b) => (a.waitingSince ?? '').localeCompare(b.waitingSince ?? ''));
  const waiting = waitingAll.slice(0, 4);
  const verifyAll = sortByAttention(activeItems.filter((item) => item.status === 'controleren' && !isSnoozed(item)));
  const verify = verifyAll.slice(0, 4);
  const filteredItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('nl-NL');
    return sortByAttention(items.filter((item) => {
      const matchesCategory = categoryFilter === 'all' || item.category === categoryFilter;
      const matchesStatus = statusFilter === 'all' || item.status === statusFilter;
      const text = `${item.title} ${item.summary} ${item.nextStep} ${categoryName(item.category)}`.toLocaleLowerCase('nl-NL');
      return matchesCategory && matchesStatus && (!query || text.includes(query));
    }));
  }, [items, categoryFilter, statusFilter, search]);

  async function scan() {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/scan', { method: 'POST' });
      const next = await responseJson<ScanResponse>(response);
      setData(next);
      const changes = next.changes;
      setScanChanges(changes);
      if (next.lastScanError) {
        setError(`Controle onvolledig: ${next.lastScanError}`);
      } else {
        setNotice(`Controle voltooid: ${changes.created} nieuw, ${changes.updated} gewijzigd, ${changes.resolved} opgelost.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'De controle is mislukt.');
    } finally {
      setScanning(false);
    }
  }

  async function updateItem(item: RadarItem, patch: Record<string, unknown>, success: string) {
    setWorkingItem(item.id);
    setError(null);
    try {
      const response = await fetch(`/api/items/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const updated = await responseJson<RadarItem>(response);
      setData((current) => current ? {
        ...current,
        items: current.items.map((candidate) => candidate.id === item.id ? updated : candidate),
      } : current);
      setNotice(success);
      setModal(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Het item kon niet worden bijgewerkt.');
    } finally {
      setWorkingItem(null);
    }
  }

  async function makeDraft(item: RadarItem) {
    setWorkingItem(item.id);
    setError(null);
    try {
      const response = await fetch(`/api/items/${encodeURIComponent(item.id)}/draft`, { method: 'POST' });
      const draft = await responseJson<Draft>(response);
      setModal({ kind: 'draft', item, draft });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Er kon geen conceptantwoord worden gemaakt.');
    } finally {
      setWorkingItem(null);
    }
  }

  async function disconnect() {
    if (!window.confirm('Google loskoppelen? Eerder gevonden items blijven in Regelradar staan.')) return;
    setError(null);
    try {
      const result = await responseJson<{ googleRevoked: boolean }>(await fetch('/api/auth/google/disconnect', { method: 'POST' }));
      setNotice(result.googleRevoked
        ? 'Google is losgekoppeld.'
        : 'De lokale Google-toegang is verwijderd. Controleer ook de toegangsrechten van Regelradar in je Google-account.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Loskoppelen is mislukt.');
    }
  }

  async function deleteData() {
    setError(null);
    try {
      await responseJson<{ deleted: boolean }>(await fetch('/api/data/delete', { method: 'POST' }));
      setModal(null);
      setNotice('Opgeslagen gegevens zijn verwijderd.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Verwijderen is mislukt.');
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      setAuth(null);
      setData(null);
      await load();
    } catch {
      setError('Afmelden is mislukt.');
    }
  }

  if (loading) return <LoadingScreen />;
  if (!auth?.authenticated) return <SignInScreen loginUrl={auth?.loginUrl ?? '/api/auth/google/start'} setupIssues={auth?.setupIssues ?? []} error={error} />;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Hoofdnavigatie">
        <a className="brand" href="#boven" aria-label="Regelradar, naar boven">
          <span className="brand-mark"><Radar size={24} strokeWidth={2.2} /></span>
          <span>regelradar<span className="brand-period">.</span></span>
        </a>
        <nav className="side-nav">
          <a className="nav-link active" href="#boven"><ClipboardList size={18} /> Overzicht</a>
          <a className="nav-link" href="#alle-items"><Inbox size={18} /> Alle items</a>
          <a className="nav-link" href="#bronnen"><ShieldCheck size={18} /> Bronnen</a>
        </nav>
        <div className="sidebar-foot">
          <span className="privacy-badge"><LockKeyhole size={14} /> Privéoverzicht</span>
          <span>Alle tijden: Amsterdam</span>
        </div>
      </aside>

      <main id="boven" className="main-content">
        <div className="topbar">
          <div className="mobile-brand"><Radar size={22} /><strong>regelradar<span>.</span></strong></div>
          <span className="topbar-location">Overzicht <span>/</span> Vandaag</span>
          <div className="topbar-actions">
            <span className="topbar-updated">Laatst bijgewerkt: {dateLabel(data?.lastUpdatedAt, true) ?? 'nog niet'}</span>
            <button className="button button-primary" onClick={() => void scan()} disabled={!connected || scanInProgress}>
              <RefreshCw size={16} className={scanInProgress ? 'spin' : ''} />
              {scanInProgress ? 'Controleren…' : 'Nu controleren'}
            </button>
          </div>
        </div>

        <div className="page-content">
          <header className="page-heading">
            <div>
              <div className="eyebrow">PERSOONLIJK OVERZICHT</div>
              <h1>Wat vraagt aandacht?</h1>
              <p>Concrete acties, afspraken en zaken waarop je wacht. Onderbouwd met je bronnen.</p>
            </div>
            <div className="today-chip"><CalendarDays size={16} /> {new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</div>
          </header>

          {error ? <div className="alert error-alert" role="alert"><CircleAlert size={18} /><span>{error}</span><button aria-label="Melding sluiten" onClick={() => setError(null)}><X size={16} /></button></div> : null}
          {!error && data?.scanState === 'error' && data.lastScanError ? <div className="alert error-alert" role="alert"><CircleAlert size={18} /><span>Laatste controle mislukt: {data.lastScanError}</span></div> : null}
          {notice ? <div className="alert success-alert" role="status"><CircleCheck size={18} /><span>{notice}</span><button aria-label="Melding sluiten" onClick={() => setNotice(null)}><X size={16} /></button></div> : null}

          <CoverageBanner connected={connected} hasScanned={hasScanned} sources={data?.sources ?? []} />
          {scanChanges ? <ScanChanges changes={scanChanges} /> : null}

          <div className="metric-grid" aria-label="Samenvatting">
            <Metric label="Nu regelen" count={dueNowAll.length} icon={<ArrowUpRight size={20} />} tone="primary" detail="open acties" href="#nu-regelen" />
            <Metric label="Binnenkort" count={upcomingAll.length} icon={<CalendarDays size={20} />} tone="blue" detail="afspraken en deadlines" href="#binnenkort" />
            <Metric label="Wachten" count={waitingAll.length} icon={<Clock3 size={20} />} tone="violet" detail="op iemand anders" href="#wachten" />
            <Metric label="Controleren" count={verifyAll.length} icon={<CircleAlert size={20} />} tone="amber" detail="punten met onzekerheid" href="#controleren" />
          </div>

          <div className="overview-grid">
            <section id="nu-regelen" className="panel focus-panel">
              <SectionHeading icon={<ArrowUpRight size={19} />} title="Nu regelen" count={dueNowAll.length} subtitle="Maximaal vijf acties met de hoogste prioriteit" />
              {dueNow.length ? <div className="summary-list">{dueNow.map((item) => <SummaryRow key={item.id} item={item} />)}</div> : <EmptySection icon={<CircleCheck size={23} />} title={hasScanned ? 'Geen bevestigde open acties' : 'Nog geen acties om te tonen'} text={hasScanned ? 'Geen open acties gevonden in de gecontroleerde bronnen.' : 'Koppel je bronnen en start een controle om concrete acties te zien.'} />}
              {dueNowAll.length > 5 ? <a className="show-more" href="#alle-items" onClick={() => setStatusFilter('actie_nodig')}>Bekijk alle {dueNowAll.length} acties <ArrowRight size={15} /></a> : null}
            </section>
            <div className="secondary-column">
              <section id="binnenkort" className="panel compact-panel">
                <SectionHeading icon={<CalendarDays size={18} />} title="Binnenkort" count={upcomingAll.length} />
                {upcoming.length ? <div className="mini-list">{upcoming.map((item) => <MiniRow key={item.id} item={item} meta={item.dueAt ? dateLabel(item.dueAt) : 'Gepland'} />)}</div> : <p className="empty-line">Geen onderbouwde afspraken of deadlines gevonden.</p>}
              </section>
              <section id="wachten" className="panel compact-panel">
                <SectionHeading icon={<Clock3 size={18} />} title="Wachten op anderen" count={waitingAll.length} />
                {waiting.length ? <div className="mini-list">{waiting.map((item) => <MiniRow key={item.id} item={item} meta={item.waitingSince ? `Sinds ${dateLabel(item.waitingSince)}` : 'Sinds wanneer onbekend'} />)}</div> : <p className="empty-line">Geen open punten waarbij iemand anders aan zet is.</p>}
              </section>
              <section id="controleren" className="panel compact-panel">
                <SectionHeading icon={<CircleAlert size={18} />} title="Even controleren" count={verifyAll.length} />
                {verify.length ? <div className="mini-list">{verify.map((item) => <MiniRow key={item.id} item={item} meta={item.uncertainty ?? 'Bevestiging ontbreekt'} />)}</div> : <p className="empty-line">Geen onzekere punten gevonden.</p>}
              </section>
            </div>
          </div>

          <section id="alle-items" className="all-items-section">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">ALLE GEVONDEN PUNTEN</div>
                <h2>Volledig overzicht <span>{items.length}</span></h2>
              </div>
              <p>Ook afgeronde en genegeerde items blijven hier zichtbaar.</p>
            </div>
            <div className="filters">
              <label className="search-field"><Search size={18} /><span className="sr-only">Zoek in items</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Zoek in items" /></label>
              <label className="select-wrap"><span className="sr-only">Categorie</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">Alle categorieën</option>{categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}</select><ChevronDown size={16} /></label>
              <label className="select-wrap"><span className="sr-only">Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Alle statussen</option>{statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select><ChevronDown size={16} /></label>
            </div>
            {filteredItems.length ? <div className="item-list">{filteredItems.map((item) => <ItemCard key={item.id} item={item} busy={workingItem === item.id} onUpdate={updateItem} onModal={setModal} onDraft={makeDraft} />)}</div> : <div className="empty-list"><Inbox size={26} /><h3>{items.length ? 'Geen items met deze filters' : 'Nog geen items gevonden'}</h3><p>{items.length ? 'Pas de filters aan om andere punten te zien.' : hasScanned ? 'Geen open acties gevonden in de gecontroleerde bronnen.' : 'Na de eerste broncontrole verschijnen gevonden punten hier.'}</p></div>}
          </section>

          <section id="bronnen" className="sources-section">
            <div className="section-title-row"><div><div className="eyebrow">HERKOMST EN DEKKING</div><h2>Bronnen</h2></div><p>Per bron zie je wat daadwerkelijk is gecontroleerd.</p></div>
            <div className="source-grid">{(data?.sources ?? []).map((source) => <SourceCard key={source.id} source={source} />)}</div>
            {!connected ? <a className="button button-primary connect-button" href="/api/auth/google/start"><ShieldCheck size={17} /> Google koppelen <ArrowRight size={16} /></a> : <button className="text-button disconnect-button" onClick={() => void disconnect()}>Google loskoppelen</button>}
          </section>

          <section className="privacy-panel" aria-label="Privacy en gegevens">
            <div className="privacy-icon"><LockKeyhole size={20} /></div>
            <div><h3>Jij houdt de controle</h3><p>Regelradar leest gekoppelde bronnen en verstuurt geen antwoorden automatisch. Je kunt de koppeling en opgeslagen gegevens verwijderen.</p></div>
            <div className="privacy-actions"><button className="text-button" onClick={() => setModal({ kind: 'delete' })}><Trash2 size={16} /> Gegevens verwijderen</button><button className="text-button" onClick={() => void logout()}><LogOut size={16} /> Afmelden</button></div>
          </section>
        </div>
      </main>
      {modal ? <ActionModal modal={modal} busy={workingItem === ('item' in modal ? modal.item.id : null)} onClose={() => setModal(null)} onUpdate={updateItem} onDelete={deleteData} onNotice={setNotice} /> : null}
    </div>
  );
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="loading-brand"><Radar size={30} /><strong>regelradar<span>.</span></strong></div><div className="loading-spinner" /><p>Overzicht laden…</p></div>;
}

function SignInScreen({ loginUrl, setupIssues, error }: { loginUrl: string; setupIssues: string[]; error: string | null }) {
  const needsSetup = setupIssues.length > 0;
  return <div className="signin-page"><div className="signin-card"><div className="signin-mark"><Radar size={30} /></div><span className="eyebrow">PERSOONLIJK OVERZICHT</span><h1>{needsSetup ? 'Regelradar instellen' : 'Houd je losse eindjes in beeld.'}</h1><p>{needsSetup ? 'De app kan nog geen bronnen koppelen. Controleer de onderstaande instellingen en start de app daarna opnieuw.' : 'Log in om je eigen acties, afspraken en open vragen te bekijken. Regelradar toont alleen gegevens uit bronnen die je zelf koppelt.'}</p>{needsSetup ? <div className="setup-issues"><strong>Instellingen controleren</strong><ul>{setupIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div> : null}{error ? <div className="alert error-alert" role="alert"><CircleAlert size={18} />{error}</div> : null}{!needsSetup ? <a className="button button-primary signin-button" href={loginUrl || '/api/auth/google/start'}><LockKeyhole size={17} /> Inloggen met Google <ArrowRight size={17} /></a> : null}<div className="signin-note"><ShieldCheck size={17} /> Alleen-lezen toegang tot je bronnen</div></div></div>;
}

function ScanChanges({ changes }: { changes: ScanResponse['changes'] }) {
  const groups = [
    { key: 'created' as const, label: 'Nieuw', entries: changes.details.created },
    { key: 'updated' as const, label: 'Gewijzigd', entries: changes.details.updated },
    { key: 'resolved' as const, label: 'Opgelost', entries: changes.details.resolved },
  ];
  if (!groups.some((group) => group.entries.length)) return <div className="changes-panel"><CircleCheck size={17} /><span>Geen nieuwe, gewijzigde of opgeloste items sinds de vorige controle.</span></div>;
  return <section className="changes-panel" aria-label="Wijzigingen sinds vorige controle"><div className="changes-heading"><RefreshCw size={17} /><strong>Sinds de vorige controle</strong></div><div className="changes-groups">{groups.filter((group) => group.entries.length).map((group) => <div key={group.key}><span className={`change-label change-${group.key}`}>{group.label} · {group.entries.length}</span><ul>{group.entries.map((entry) => <li key={entry.id}><a href={`#item-${entry.id}`}>{entry.title}</a></li>)}</ul></div>)}</div></section>;
}

function CoverageBanner({ connected, hasScanned, sources }: { connected: boolean; hasScanned: boolean; sources: SourceState[] }) {
  const incomplete = sources.some((source) => !source.connected || source.result === 'gedeeltelijk' || source.result === 'mislukt');
  const warning = connected && hasScanned && incomplete;
  const title = !connected ? 'Geen bronnen gekoppeld' : !hasScanned ? 'Klaar voor de eerste controle' : incomplete ? 'Broncontrole onvolledig' : 'Broncontrole uitgevoerd';
  const text = !connected
    ? hasScanned
      ? 'Er worden geen nieuwe gegevens gelezen. Eerder gevonden items blijven zichtbaar.'
      : 'Koppel Google om Gmail en Agenda alleen-lezen te controleren. Er zijn nog geen gegevens gelezen.'
    : !hasScanned
      ? 'Start een controle om concrete open punten uit je gekoppelde bronnen te vinden.'
      : incomplete
        ? 'Bekijk hieronder welke bron niet volledig is gecontroleerd. Het overzicht kan daardoor punten missen.'
        : 'Je overzicht is gebaseerd op de hieronder vermelde bronnen en zoekperioden.';
  return <div className={`coverage-banner ${warning ? 'coverage-warning' : ''}`}><span className="coverage-icon">{warning ? <CircleAlert size={20} /> : <ShieldCheck size={20} />}</span><div><strong>{title}</strong><p>{text}</p></div><a href="#bronnen">Bekijk bronnen <ArrowRight size={16} /></a></div>;
}

function Metric({ label, count, icon, tone, detail, href }: { label: string; count: number; icon: ReactNode; tone: string; detail: string; href: string }) {
  return <a className={`metric metric-${tone}`} href={href}><span className="metric-top"><span className="metric-icon">{icon}</span><ArrowUpRight size={16} className="metric-arrow" /></span><span className="metric-count">{count}</span><span className="metric-label">{label}</span><span className="metric-detail">{detail}</span></a>;
}

function SectionHeading({ icon, title, count, subtitle }: { icon: ReactNode; title: string; count: number; subtitle?: string }) {
  return <div className="panel-heading"><span className="panel-heading-icon">{icon}</span><div><h2>{title} <span className="panel-count">{count}</span></h2>{subtitle ? <p>{subtitle}</p> : null}</div></div>;
}

function EmptySection({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="empty-section"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>;
}

function SummaryRow({ item }: { item: RadarItem }) {
  return <a className="summary-row" href={`#item-${item.id}`}><span className={`priority-line priority-${item.priority}`} /><span className="summary-copy"><strong>{item.title}</strong><small>{item.nextStep}</small></span><span className="summary-tail">{item.dueAt ? dateLabel(item.dueAt) : categoryName(item.category)}<ArrowRight size={16} /></span></a>;
}

function MiniRow({ item, meta }: { item: RadarItem; meta: string | null }) {
  return <a className="mini-row" href={`#item-${item.id}`}><span><strong>{item.title}</strong><small>{meta}</small></span><ArrowUpRight size={15} /></a>;
}

function ItemCard({ item, busy, onUpdate, onModal, onDraft }: { item: RadarItem; busy: boolean; onUpdate: (item: RadarItem, patch: Record<string, unknown>, success: string) => Promise<void>; onModal: (modal: Modal) => void; onDraft: (item: RadarItem) => Promise<void> }) {
  const firstSource = item.sourceRefs.map((source) => ({ ...source, safeUrl: safeSourceUrl(source.url) })).find((source) => source.safeUrl);
  const hasGmail = item.sourceRefs.some((source) => source.kind === 'gmail');
  return <article id={`item-${item.id}`} className="item-card">
    <div className="item-main">
      <div className="item-topline"><span className={`status-pill status-${item.status}`}>{statusName(item.status)}</span><span className="category-label">{categoryName(item.category)}</span>{item.priority === 'hoog' ? <span className="high-priority">Hoge prioriteit</span> : null}</div>
      <h3>{item.title}</h3>
      <p className="item-summary">{item.summary}</p>
      {item.uncertainty ? <div className="uncertainty"><CircleAlert size={16} /><span>{item.uncertainty}</span></div> : null}
      <div className="next-step"><span>VOLGENDE STAP</span><strong>{item.nextStep}</strong></div>
      <div className="item-facts"><span><UserRound size={15} /> {item.owner}</span>{item.dueAt ? <span><CalendarDays size={15} /> {item.status === 'gepland' ? 'Afspraak' : 'Deadline'}: {dateLabel(item.dueAt)}</span> : null}{item.waitingSince ? <span><Clock3 size={15} /> Wacht sinds {dateLabel(item.waitingSince)}</span> : null}{item.suggestedFollowUpAt ? <span><AlarmClock size={15} /> Voorgestelde opvolging: {dateLabel(item.suggestedFollowUpAt)}</span> : null}{item.snoozedUntil ? <span><AlarmClock size={15} /> Uitgesteld tot {dateLabel(item.snoozedUntil)}</span> : null}</div>
      {item.priorityReason ? <p className="priority-reason">Prioriteit: {item.priorityReason}</p> : null}
    </div>
    <div className="item-bottom"><div className="source-links">{item.sourceRefs.map((source, index) => { const href = safeSourceUrl(source.url); return href ? <a key={`${source.url}-${index}`} href={href} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> {source.label}</a> : null; })}{item.sourceRefs.length === 0 ? <span>Geen bronverwijzing beschikbaar</span> : null}</div><span className="last-checked">Gecontroleerd {dateLabel(item.lastCheckedAt, true) ?? 'onbekend'}</span></div>
    <div className="item-actions">
      {firstSource ? <a className="action-button action-source" href={firstSource.safeUrl!} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /> Bron openen</a> : <span className="action-button action-disabled">Geen bronlink</span>}
      {item.status === 'afgerond' || item.status === 'genegeerd' ? <button className="action-button" disabled={busy} onClick={() => void onUpdate(item, { status: 'actie_nodig' }, 'Item opnieuw geopend.')}><RefreshCw size={15} /> Heropenen</button> : <button className="action-button action-done" disabled={busy} onClick={() => void onUpdate(item, { status: 'afgerond' }, 'Item afgerond.')}><Check size={15} /> Afgerond</button>}
      <button className="action-button" disabled={busy} onClick={() => onModal({ kind: 'snooze', item })}><AlarmClock size={15} /> Uitstellen</button>
      <button className="action-button" disabled={busy} onClick={() => void onUpdate(item, { status: 'wachten_op_ander' }, 'Gemarkeerd als wachten op een ander.')}><Clock3 size={15} /> Wachten op ander</button>
      <button className="action-button" disabled={busy} onClick={() => void onUpdate(item, { status: 'genegeerd' }, 'Gemarkeerd als niet relevant.')}><Ban size={15} /> Niet relevant</button>
      <button className="action-button" disabled={busy} onClick={() => onModal({ kind: 'correct', item })}><SquarePen size={15} /> Corrigeren</button>
      <button className="action-button" disabled={busy || !hasGmail} title={hasGmail ? undefined : 'Alleen beschikbaar voor e-mailitems'} onClick={() => void onDraft(item)}><MessageSquareText size={15} /> Conceptantwoord</button>
    </div>
  </article>;
}

function SourceCard({ source }: { source: SourceState }) {
  const icon = source.id === 'gmail' ? <Mail size={21} /> : <CalendarDays size={21} />;
  const resultLabel: Record<SourceState['result'], string> = { volledig: 'Volledig', gedeeltelijk: 'Gedeeltelijk', mislukt: 'Mislukt', nooit: 'Nog niet gecontroleerd' };
  return <div className="source-card"><div className="source-head"><span className={`source-icon source-${source.id}`}>{icon}</span><div><h3>{source.name}</h3><span className={`connection-label ${source.connected ? 'is-connected' : ''}`}>{source.connected ? 'Aangesloten' : 'Niet aangesloten'}</span></div></div><dl><div><dt>Laatste succesvolle controle</dt><dd>{dateLabel(source.lastCheckedAt, true) ?? 'Nog niet'}</dd></div><div><dt>Doorzochte periode</dt><dd>{source.searchWindowStart && source.searchWindowEnd ? `${dateLabel(source.searchWindowStart)} – ${dateLabel(source.searchWindowEnd)}` : 'Nog niet bekend'}</dd></div><div><dt>Resultaat</dt><dd><span className={`result result-${source.result}`}>{resultLabel[source.result]}</span></dd></div></dl>{source.note ? <p className="source-note">{source.note}</p> : null}</div>;
}

function ActionModal({ modal, busy, onClose, onUpdate, onDelete, onNotice }: { modal: Modal; busy: boolean; onClose: () => void; onUpdate: (item: RadarItem, patch: Record<string, unknown>, success: string) => Promise<void>; onDelete: () => Promise<void>; onNotice: (value: string) => void }) {
  const [snoozeDate, setSnoozeDate] = useState(modal.kind === 'snooze' ? dateInputValue(modal.item.snoozedUntil) : '');

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  function submitSnooze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (modal.kind !== 'snooze' || !snoozeDate) return;
    void onUpdate(modal.item, { snoozedUntil: snoozeDate }, `Uitgesteld tot ${dateLabel(snoozeDate)}.`);
  }

  function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (modal.kind !== 'correct') return;
    const fields = new FormData(event.currentTarget);
    const dueAt = String(fields.get('dueAt') ?? '').trim();
    void onUpdate(modal.item, { correction: {
      title: String(fields.get('title') ?? '').trim(),
      summary: String(fields.get('summary') ?? '').trim(),
      nextStep: String(fields.get('nextStep') ?? '').trim(),
      category: String(fields.get('category') ?? ''),
      owner: String(fields.get('owner') ?? '').trim(),
      dueAt: dueAt || null,
    } }, 'Correctie opgeslagen.');
  }

  async function copyDraft() {
    if (modal.kind !== 'draft') return;
    try {
      await navigator.clipboard.writeText(`Onderwerp: ${modal.draft.subject}\n\n${modal.draft.body}`);
      onNotice('Concept gekopieerd.');
    } catch {
      onNotice('Selecteer de concepttekst om die te kopiëren.');
    }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><span className="modal-icon">{modal.kind === 'snooze' ? <AlarmClock size={21} /> : modal.kind === 'correct' ? <SquarePen size={21} /> : modal.kind === 'draft' ? <MessageSquareText size={21} /> : <Trash2 size={21} />}</span><button className="icon-button" onClick={onClose} aria-label="Sluiten" autoFocus><X size={19} /></button></div>
    {modal.kind === 'snooze' ? <form onSubmit={submitSnooze}><h2 id="modal-title">Uitstellen</h2><p className="modal-description">{modal.item.title}</p><label className="form-field">Toon opnieuw op<input type="date" min={todayInAmsterdam()} value={snoozeDate} onChange={(event) => setSnoozeDate(event.target.value)} required /></label><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Annuleren</button><button className="button button-primary" disabled={busy || !snoozeDate}>Uitstellen</button></div></form> : null}
    {modal.kind === 'correct' ? <form onSubmit={submitCorrection}><h2 id="modal-title">Item corrigeren</h2><p className="modal-description">Pas een feit of de volgende stap aan. Je correctie blijft bewaard bij volgende controles.</p><div className="form-grid"><label className="form-field full">Titel<input name="title" defaultValue={modal.item.title} required /></label><label className="form-field full">Uitleg<textarea name="summary" defaultValue={modal.item.summary} rows={3} required /></label><label className="form-field full">Volgende stap<input name="nextStep" defaultValue={modal.item.nextStep} required /></label><label className="form-field">Categorie<select name="category" defaultValue={modal.item.category}>{categories.map((category) => <option value={category.value} key={category.value}>{category.label}</option>)}</select></label><label className="form-field">Wie is aan zet?<input name="owner" defaultValue={modal.item.owner} required /></label><label className="form-field">Deadline of afspraakdatum<input name="dueAt" type="date" defaultValue={dateInputValue(modal.item.dueAt)} /></label></div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Annuleren</button><button className="button button-primary" disabled={busy}>Correctie opslaan</button></div></form> : null}
    {modal.kind === 'draft' ? <div><h2 id="modal-title">Conceptantwoord</h2><p className="modal-description">Voor {modal.item.title}. Dit concept wordt niet verstuurd.</p><label className="form-field">Onderwerp<input value={modal.draft.subject} readOnly /></label><label className="form-field">Bericht<textarea value={modal.draft.body} rows={9} readOnly /></label><p className="draft-disclaimer"><CircleAlert size={16} /> {modal.draft.disclaimer}</p><div className="modal-actions"><button className="button button-secondary" onClick={onClose}>Sluiten</button><button className="button button-primary" onClick={() => void copyDraft()}><Copy size={16} /> Kopiëren</button></div></div> : null}
    {modal.kind === 'delete' ? <div><h2 id="modal-title">Gegevens verwijderen?</h2><p className="modal-description">Alle lokaal opgeslagen items, bronstatus en Google-toegang worden verwijderd. Dit kun je niet ongedaan maken.</p><div className="modal-actions"><button className="button button-secondary" onClick={onClose}>Annuleren</button><button className="button button-danger" onClick={() => void onDelete()}><Trash2 size={16} /> Alles verwijderen</button></div></div> : null}
  </div></div>;
}
