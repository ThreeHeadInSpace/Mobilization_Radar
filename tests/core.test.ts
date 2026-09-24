import { describe, it, expect } from "vitest";
import { normalizeUrl, uniqueArticles } from "../src/normalization/index.js";
import { verifyFindings } from "../src/intelligence/index.js";
import { score, review } from "../src/scoring/index.js";
import {
  deepLink,
  makeReport,
  sourcePages,
  formatReport,
} from "../src/reports/index.js";
import { parseFeed, collect } from "../src/collectors/index.js";
import { secureEqual } from "../src/http.js";
import { cfg, source, article, finding } from "./fixtures.js";
import { analysisSchema } from "../src/domain.js";
function raw(e: any) {
  const { chains, evidenceTypes, change, freshOfficial, ...r } = e;
  return r;
}
describe("normalization and collectors", () => {
  it("removes tracking and preserves meaningful query", () =>
    expect(
      normalizeUrl("https://WWW.example.org/a/?utm_source=x&b=2&a=1#top"),
    ).toBe("https://example.org/a?a=1&b=2"));
  it("rejects unsafe schemes", () =>
    expect(() => normalizeUrl("file:///secret")).toThrow());
  it("deduplicates URL or content hash", () => {
    const a = article();
    expect(
      uniqueArticles([a, { ...a, canonical_url: "https://other.test" }]),
    ).toHaveLength(1);
  });
  it("parses RSS timestamps and strips markup", () => {
    const rows = parseFeed(
      "<rss><channel><item><title>Повестки</title><link>https://example.org/1</link><description>Обычный учёт</description><pubDate>Thu, 24 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>",
      source,
    );
    expect(rows[0].published_at).toBe("2026-09-24T10:00:00.000Z");
  });
  it("isolates errors and records retries", async () => {
    const r = await collect(source, async () => {
      throw new Error("offline");
    });
    expect(r.status).toBe("error");
    expect(r.retryCount).toBe(1);
  });
});
describe("evidence and scoring", () => {
  it("rejects invented quotes", () => {
    const a = article(),
      f = raw(finding(a));
    f.evidence[0].quote = "Несуществующая цитата";
    expect(() =>
      verifyFindings({ events: [f], limitations: [] }, [a], [source], []),
    ).toThrow("ungrounded");
  });
  it("many republications are one chain", () => {
    const a = article(),
      f = raw(finding(a));
    f.evidence[0].independent = false;
    f.evidence[0].evidenceType = "rumor";
    f.verificationStatus = "CONFIRMED_MULTI_SOURCE";
    f.evidence = Array.from({ length: 30 }, () => ({ ...f.evidence[0] }));
    const r = verifyFindings(
      { events: [f], limitations: [] },
      [a],
      [source],
      [],
    );
    expect(r[0].chains).toHaveLength(0);
    expect(score(r, 1, null, cfg).level).toBe(1);
  });
  it("routine procedures remain zero", () =>
    expect(score([{ ...finding(), routine: true }], 1, null, cfg).level).toBe(
      0,
    ));
  it("missing coverage is unknown", () =>
    expect(score([], 0, null, cfg).level).toBeNull());
  it("regional mass signal does not color country", () => {
    const f = {
      ...finding(),
      mass: true,
      chains: ["a", "b", "c"],
      evidenceTypes: ["official_statement", "original_reporting"],
    };
    expect(score([f], 1, null, cfg).level).toBe(4);
    expect(score([f], 1, null, cfg, true).level).toBe(2);
  });
  it("old official act never gets freshOfficial", () => {
    const a = article();
    a.published_at = "2022-09-21T00:00:00Z";
    const f = raw(finding(a));
    f.officialAction = "announcement";
    f.officialScope = "Российская Федерация";
    const r = verifyFindings(
      { events: [f], limitations: [] },
      [a],
      [{ ...source, type: "OFFICIAL_LEGAL" }],
      [],
    );
    expect(r[0].freshOfficial).toBe(false);
  });
  it("new federal action can be five and always reviewed", () => {
    const f = {
      ...finding(),
      officialAction: "announcement" as const,
      officialScope: "Российская Федерация",
      freshOfficial: true,
    };
    const s = score([f], 1, null, cfg, true);
    expect(s.level).toBe(5);
    expect(review(s, [f], cfg).reviewState).toBe("CRITICAL_REVIEW");
  });
  it("safe auto mode still reviews conflicts and unknown coverage", () => {
    const c = {
      ...cfg,
      REQUIRE_REVIEW_ALL: false,
      AUTO_PUBLISH_SAFE_REPORTS: true,
    };
    expect(review(score([], 1, null, c), [], c).reviewRequired).toBe(false);
    expect(review(score([], 0, null, c), [], c).reviewRequired).toBe(true);
  });
  it("strict schema rejects model index", () =>
    expect(() =>
      analysisSchema.parse({ events: [], limitations: [], level: 5 }),
    ).toThrow());
});
describe("reports and authorization", () => {
  it("keeps link payload under limit", () => {
    expect(deepLink("radarm_bot", "sources_" + "a".repeat(24))).toContain(
      "?start=",
    );
    expect(() => deepLink("bot", "x".repeat(65))).toThrow();
  });
  it("formats cited findings, no HTML parsing or probability", () => {
    const a = article();
    const r = makeReport(
      [finding(a)],
      [a],
      [source],
      [
        {
          sourceId: source.id,
          status: "ok",
          httpCode: 200,
          errorCode: null,
          duration: 1,
          itemsDiscovered: 1,
          retryCount: 0,
          articles: [],
        },
      ],
      null,
      cfg,
    );
    expect(r.telegramText).toContain("[1]");
    expect(r.telegramText.length).toBeLessThan(4096);
    expect(sourcePages(r).join("")).toContain(a.canonical_url);
    expect(formatReport(r, cfg)).not.toContain("78%");
  });
  it("compares published previous level", () => {
    const a = article();
    const r = makeReport([], [], [source], [], null, cfg);
    r.federalSignal.level = 3;
    const next = makeReport([], [], [source], [], r, cfg);
    expect(next.federalSignal.previousLevel).toBe(3);
  });
  it("constant time auth rejects missing and unicode", () => {
    expect(secureEqual(undefined, "a".repeat(32))).toBe(false);
    expect(secureEqual("a".repeat(32), "a".repeat(32))).toBe(true);
    expect(secureEqual("я".repeat(32), "a".repeat(32))).toBe(false);
  });
});
