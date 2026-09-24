import type { z } from "zod";
import {
  analysisSchema,
  type Article,
  type Finding,
  type Source,
} from "../domain.js";
import { hash, normalizeUrl } from "../normalization/index.js";
const compact = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
export function verifyFindings(
  raw: z.infer<typeof analysisSchema>,
  articles: Article[],
  sources: Source[],
  history: Finding[],
  now = new Date(),
): Finding[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  return raw.events.map((e) => {
    const chains = new Set<string>(),
      types = new Set<string>();
    const quoteOrigins = new Map<string, string>();
    for (const evidence of e.evidence) {
      const a = byId.get(evidence.articleId);
      if (!a || !compact(a.text).includes(compact(evidence.quote)))
        throw new Error("ungrounded_evidence");
      if (
        evidence.originalUrl &&
        !a.raw_metadata.links.some(
          (l) => normalizeUrl(l) === normalizeUrl(evidence.originalUrl!),
        )
      )
        throw new Error("ungrounded_origin");
      // Unknown origins share one chain. A publisher is not an independent source merely because it reposted.
      const origin = evidence.originalUrl
        ? normalizeUrl(evidence.originalUrl)
        : null;
      const source = sourceMap.get(a.source_id);
      const primary =
        evidence.independent &&
        [
          "legal_document",
          "official_statement",
          "original_reporting",
          "citizen_report",
        ].includes(evidence.evidenceType);
      const referenced = origin
        ? articles.find((x) => x.canonical_url === origin)
        : null;
      let chain = referenced
        ? `publisher:${new URL(sourceMap.get(referenced.source_id)?.base_url ?? referenced.canonical_url).hostname.replace(/^www\./, "")}`
        : origin
          ? `origin:${origin}`
          : primary
            ? `publisher:${new URL(source?.base_url ?? a.canonical_url).hostname.replace(/^www\./, "")}`
            : "unknown";
      const quoteKey = hash(evidence.quote);
      if (quoteOrigins.has(quoteKey)) chain = quoteOrigins.get(quoteKey)!;
      else quoteOrigins.set(quoteKey, chain);
      chains.add(chain);
      types.add(evidence.evidenceType);
    }
    const same = history.find(
      (h) =>
        h.canonicalKey === e.canonicalKey ||
        h.canonicalKey === hash(e.canonicalKey) ||
        h.evidence.some((old) =>
          e.evidence.some((n) => n.articleId === old.articleId),
        ),
    );
    const actualChains = [
      ...new Set([...chains, ...(same?.chains ?? [])]),
    ].filter((c) => c !== "unknown");
    let status = e.verificationStatus;
    const trustedPrimary = e.evidence.some((ev) => {
      const a = byId.get(ev.articleId)!;
      return (
        sourceMap.get(a.source_id)?.type.startsWith("OFFICIAL_") &&
        ["legal_document", "official_statement"].includes(ev.evidenceType)
      );
    });
    if (status === "CONFIRMED_MULTI_SOURCE" && actualChains.length < 2)
      status = "SINGLE_SOURCE";
    if (status === "CONFIRMED_PRIMARY" && !trustedPrimary)
      status = "SINGLE_SOURCE";
    const freshOfficial =
      e.officialAction !== "none" &&
      trustedPrimary &&
      e.evidence.some((ev) => {
        const a = byId.get(ev.articleId)!;
        return (
          ["OFFICIAL_LEGAL", "OFFICIAL_FEDERAL"].includes(
            sourceMap.get(a.source_id)?.type ?? "",
          ) &&
          a.published_at &&
          Date.parse(a.published_at) >= now.getTime() - 86400000 &&
          Date.parse(a.published_at) <= now.getTime() &&
          ["legal_document", "official_statement"].includes(ev.evidenceType)
        );
      }) &&
      !!e.occurredAt &&
      Date.parse(e.occurredAt) >= now.getTime() - 86400000 &&
      Date.parse(e.occurredAt) <= now.getTime() &&
      !same;
    const oldEvent =
      e.occurredAt !== null &&
      Number.isFinite(Date.parse(e.occurredAt)) &&
      Date.parse(e.occurredAt) < now.getTime() - 48 * 3600000;
    const change = !same
      ? oldEvent
        ? "unchanged"
        : "new"
      : same.verificationStatus !== status
        ? "status_change"
        : actualChains.some((c) => !same.chains.includes(c))
          ? "confirmation"
          : "unchanged";
    const evidence = [
      ...new Map(
        [...(same?.evidence ?? []), ...e.evidence].map((ev) => [
          `${ev.articleId}:${ev.quote}`,
          ev,
        ]),
      ).values(),
    ];
    return {
      ...e,
      evidence,
      canonicalKey: same?.canonicalKey ?? hash(e.canonicalKey),
      verificationStatus: status,
      chains: actualChains,
      evidenceTypes: [...new Set([...types, ...(same?.evidenceTypes ?? [])])],
      change,
      freshOfficial,
    };
  });
}
