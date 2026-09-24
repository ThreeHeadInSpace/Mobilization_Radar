import { randomUUID } from "node:crypto";
import { envSchema } from "../src/config/index.js";
import type { Article, Source, Finding } from "../src/domain.js";
import { hash } from "../src/normalization/index.js";
export const cfg = envSchema.parse({
  TELEGRAM_ADMIN_CHAT_ID: "11",
  TELEGRAM_CHANNEL_ID: "-10022",
  TELEGRAM_BOT_TOKEN: "test-only",
  ENABLE_WEB_SEARCH: false,
});
export const source: Source = {
  id: "fixture-source",
  name: "Тестовый источник",
  type: "OFFICIAL_REGIONAL",
  base_url: "https://example.org/feed",
  region: "Тестовая область",
  collection_method: "rss",
  active: true,
  reliability_metadata: {},
};
export function article(): Article {
  const text =
    "Опубликовано необычное распоряжение о вызове запасников в двух муниципалитетах. Причины и масштабы требуют дополнительной проверки.";
  return {
    id: randomUUID(),
    source_id: source.id,
    canonical_url: "https://example.org/news/1",
    original_url: "https://example.org/news/1",
    title: "Тестовая публикация",
    text,
    published_at: new Date().toISOString(),
    discovered_at: new Date().toISOString(),
    content_hash: hash(text),
    region: source.region,
    raw_metadata: { links: [] },
  };
}
export function finding(a = article()): Finding {
  return {
    canonicalKey: "test-event",
    eventType: "unusual_summons",
    region: source.region,
    summary: "Сообщается о необычном вызове запасников.",
    verificationStatus: "CONFIRMED_PRIMARY",
    routine: false,
    unusual: true,
    mass: false,
    municipalities: ["Город А", "Город Б"],
    occurredAt: a.published_at,
    officialAction: "none",
    officialScope: null,
    evidence: [
      {
        articleId: a.id,
        quote: "Опубликовано необычное распоряжение о вызове запасников",
        originalUrl: null,
        independent: true,
        evidenceType: "official_statement",
        role: "Первичное сообщение",
      },
    ],
    chains: ["publisher:example.org"],
    evidenceTypes: ["official_statement"],
    change: "new",
    freshOfficial: false,
  };
}
