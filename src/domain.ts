import { z } from "zod";
export const sourceTypes = [
  "OFFICIAL_LEGAL",
  "OFFICIAL_FEDERAL",
  "OFFICIAL_REGIONAL",
  "MAJOR_MEDIA",
  "INDEPENDENT_MEDIA",
  "LEGAL_NGO",
  "REGIONAL_MEDIA",
  "TELEGRAM",
  "FIELD_REPORT",
  "ANALYTICAL",
  "OTHER",
] as const;
export type Source = {
  id: string;
  name: string;
  type: (typeof sourceTypes)[number];
  base_url: string;
  region: string | null;
  collection_method: "rss" | "html" | "telegram" | "manual";
  active: boolean;
  reliability_metadata: Record<string, unknown>;
};
export type Article = {
  id: string;
  source_id: string;
  canonical_url: string;
  original_url: string;
  title: string;
  published_at: string | null;
  discovered_at: string;
  text: string;
  content_hash: string;
  region: string | null;
  raw_metadata: { links: string[]; [key: string]: unknown };
};
export const triageSchema = z
  .object({
    relevant: z.boolean(),
    eventType: z.string(),
    region: z.string().nullable(),
    sourceRole: z.enum(["primary", "republication", "commentary", "unknown"]),
    primarySourceLikelihood: z.enum(["high", "medium", "low", "unknown"]),
    novelty: z.enum(["new", "old", "unknown"]),
    verificationHint: z.string(),
    needsDeepAnalysis: z.boolean(),
  })
  .strict();
export const verification = z.enum([
  "CONFIRMED_PRIMARY",
  "CONFIRMED_MULTI_SOURCE",
  "SINGLE_SOURCE",
  "UNVERIFIED",
  "CONTRADICTED",
  "DEBUNKED",
]);
export const evidenceSchema = z
  .object({
    articleId: z.string(),
    quote: z.string().min(12).max(500),
    originalUrl: z.string().nullable(),
    independent: z.boolean(),
    evidenceType: z.enum([
      "legal_document",
      "official_statement",
      "original_reporting",
      "citizen_report",
      "rumor",
      "analysis",
    ]),
    role: z.string().max(180),
  })
  .strict();
export const findingSchema = z
  .object({
    canonicalKey: z.string().min(4).max(160),
    eventType: z.string().max(80),
    region: z.string().nullable(),
    summary: z.string().min(1).max(400),
    verificationStatus: verification,
    routine: z.boolean(),
    unusual: z.boolean(),
    mass: z.boolean(),
    municipalities: z.array(z.string()).max(30),
    occurredAt: z.string().nullable(),
    officialAction: z.enum(["none", "announcement", "expansion", "change"]),
    officialScope: z.string().nullable(),
    evidence: z.array(evidenceSchema).min(1).max(30),
  })
  .strict();
export const analysisSchema = z
  .object({
    events: z.array(findingSchema).max(40),
    limitations: z.array(z.string()).max(15),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema> & {
  chains: string[];
  evidenceTypes: string[];
  change: "new" | "unchanged" | "confirmation" | "status_change";
  freshOfficial: boolean;
};
export type Signal = {
  level: number | null;
  previousLevel: number | null;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  coverage: "checked" | "partial" | "unknown";
};
export type CollectorResult = {
  sourceId: string;
  status: "ok" | "partial" | "error" | "unsupported";
  httpCode: number | null;
  errorCode: string | null;
  duration: number;
  itemsDiscovered: number;
  retryCount: number;
  articles: Article[];
};
export type Report = {
  publicId: string;
  reportDate: string;
  checkedAt: string;
  federalSignal: Signal;
  regionalSignals: Record<string, Signal>;
  events: Finding[];
  confirmedFacts: Finding[];
  unverifiedClaims: Finding[];
  contradictedClaims: Finding[];
  debunkedClaims: Finding[];
  officialAction: { detected: boolean; events: Finding[] };
  whatChanged: string[];
  coverage: { checked: number; total: number; ratio: number };
  runStatus: string;
  reviewRequired: boolean;
  reviewState: string;
  reviewReasons: string[];
  telegramText: string;
  sources: Snapshot[];
};
export type Snapshot = {
  articleId: string;
  sourceName: string;
  url: string;
  title: string;
  publishedAt: string | null;
  checkedAt: string;
  sourceType: string;
  role: string;
  verificationStatus: string;
  findingKey: string;
  excerpt: string;
  contentHash: string;
};
