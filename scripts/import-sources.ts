import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { hash, normalizeUrl } from "../src/normalization/index.js";
import { config } from "../src/config/index.js";
import { SupabaseDB } from "../src/database/index.js";
import type { Source } from "../src/domain.js";
const text = readFileSync("Ссылки для анализа.txt", "utf8");
const regions: Record<string, string> = {
  "fontanka.ru": "Санкт-Петербург",
  "msk1.ru": "Москва",
  "e1.ru": "Свердловская область",
  "74.ru": "Челябинская область",
  "ngs.ru": "Новосибирская область",
  "161.ru": "Ростовская область",
  "59.ru": "Пермский край",
  "63.ru": "Самарская область",
};
const feeds: Record<string, string> = {
  "interfax.ru": "https://www.interfax.ru/rss.asp",
  "rbc.ru": "https://rssexport.rbc.ru/rbcnews/news/30/full.rss",
  "kommersant.ru": "https://www.kommersant.ru/RSS/news.xml",
  "tass.ru": "https://tass.ru/rss/v2.xml",
  "ria.ru": "https://ria.ru/export/rss2/archive/index.xml",
  "meduza.io": "https://meduza.io/rss/all",
  "zona.media": "https://zona.media/rss",
};
const official = [
  "kremlin.ru",
  "mil.ru",
  "duma.gov.ru",
  "sozd.duma.gov.ru",
  "council.gov.ru",
  "government.ru",
];
const independent = [
  "zona.media",
  "meduza.io",
  "istories.media",
  "verstka.media",
  "theins.ru",
  "currenttime.tv",
];
const media = [
  "interfax.ru",
  "rbc.ru",
  "kommersant.ru",
  "vedomosti.ru",
  "tass.ru",
  "ria.ru",
  "rtvi.com",
];
const ngo = ["iditelesom.org", "stoparmy.org"];
const registry: Source[] = [];
for (const m of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
  const url = normalizeUrl(m[2]);
  const host = new URL(url).hostname;
  const type: Source["type"] =
    host === "publication.pravo.gov.ru"
      ? "OFFICIAL_LEGAL"
      : official.includes(host)
        ? "OFFICIAL_FEDERAL"
        : regions[host]
          ? "REGIONAL_MEDIA"
          : media.includes(host)
            ? "MAJOR_MEDIA"
            : independent.includes(host)
              ? "INDEPENDENT_MEDIA"
              : ngo.includes(host)
                ? "LEGAL_NGO"
                : host === "t.me"
                  ? "TELEGRAM"
                  : /trends|tgstat/.test(host)
                    ? "ANALYTICAL"
                    : "OTHER";
  const manual = /consultant|garant|trends|tgstat|zakupki|xn--/.test(host);
  const base = feeds[host] ?? url;
  if (registry.some((s) => s.base_url === base)) continue;
  registry.push({
    id: hash(base).slice(0, 24),
    name: m[1],
    type,
    base_url: base,
    region: regions[host] ?? null,
    collection_method: manual
      ? "manual"
      : feeds[host]
        ? "rss"
        : host === "t.me"
          ? "telegram"
          : "html",
    active: true,
    reliability_metadata: {
      seed_url: url,
      baseline_only: /consultant/.test(host),
      note: manual
        ? "Requires dedicated adapter; coverage stays unknown."
        : "Seed classification; independence verified per finding.",
    },
  });
}
const regionalOfficials: Record<string, string> = {
  "Московская область": "https://mosreg.ru/",
  Татарстан: "https://prav.tatarstan.ru/",
  Башкортостан: "https://t.me/bashkortostan_gov",
  "Краснодарский край": "https://admkrai.krasnodar.ru/",
  "Нижегородская область": "https://nobl.ru/",
  "Красноярский край": "https://krskstate.ru/",
  "Приморский край": "https://primorsky.ru/",
};
for (const [region, url] of Object.entries(regionalOfficials))
  registry.push({
    id: hash(url).slice(0, 24),
    name: `Официальный источник: ${region}`,
    type: "OFFICIAL_REGIONAL",
    base_url: normalizeUrl(url),
    region,
    collection_method: url.includes("t.me/") ? "telegram" : "html",
    active: true,
    reliability_metadata: {
      note: "Seed address; coverage is determined by successful extraction, never by registry membership.",
    },
  });
mkdirSync("data", { recursive: true });
writeFileSync("data/sources.json", JSON.stringify(registry, null, 2) + "\n");
if (process.argv.includes("--apply")) {
  const db = new SupabaseDB(config());
  for (const source of registry) await db.put("sources", source, "id");
  for (const old of await db.all("sources"))
    if (old.base_url.includes("example.invalid"))
      await db.patch("sources", { id: old.id }, { active: false });
}
console.log(
  JSON.stringify({
    sources: registry.length,
    regions: new Set(registry.map((s) => s.region).filter(Boolean)).size,
    manual: registry.filter((s) => s.collection_method === "manual").length,
  }),
);
