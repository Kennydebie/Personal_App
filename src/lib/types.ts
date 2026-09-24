export type RadarCategory =
  | "prive"
  | "woning"
  | "auto"
  | "aankopen"
  | "werk"
  | "bedrijf"
  | "kvw";

export type RadarStatus =
  | "actie_nodig"
  | "wachten_op_ander"
  | "gepland"
  | "controleren"
  | "afgerond"
  | "genegeerd";

export type RadarPriority = "hoog" | "normaal" | "laag";

export type SourceRef = {
  label: string;
  url: string;
  kind: "gmail" | "calendar";
};

export type RadarItem = {
  id: string;
  title: string;
  category: RadarCategory;
  status: RadarStatus;
  owner: string;
  summary: string;
  nextStep: string;
  dueAt: string | null;
  suggestedFollowUpAt: string | null;
  priority: RadarPriority;
  priorityReason: string;
  sourceRefs: SourceRef[];
  lastCheckedAt: string;
  waitingSince: string | null;
  uncertainty: string | null;
  snoozedUntil: string | null;
  manual: boolean;
};

export type SourceState = {
  id: "gmail" | "calendar";
  name: string;
  connected: boolean;
  lastCheckedAt: string | null;
  searchWindowStart: string | null;
  searchWindowEnd: string | null;
  result: "volledig" | "gedeeltelijk" | "mislukt" | "nooit";
  note: string | null;
};

export type DashboardResponse = {
  items: RadarItem[];
  sources: SourceState[];
  lastUpdatedAt: string | null;
  scanState: "idle" | "running" | "error";
  lastScanError: string | null;
};

export type ScanResponse = DashboardResponse & {
  changes: {
    created: number;
    updated: number;
    resolved: number;
    details: {
      created: { id: string; title: string }[];
      updated: { id: string; title: string }[];
      resolved: { id: string; title: string }[];
    };
  };
};

export type ExtractedItem = Omit<RadarItem, "id" | "lastCheckedAt" | "snoozedUntil" | "manual"> & {
  sourceKey: string;
  caseKey: string | null;
  relatedSearch?: { subject: string; counterpart: string } | null;
  fingerprint: string;
  evidenceAt: string;
};
