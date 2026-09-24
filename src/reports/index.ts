import type {
  Article,
  CollectorResult,
  Finding,
  Report,
  Source,
  Snapshot,
} from "../domain.js";
import type { Config } from "../config/index.js";
import { day } from "../config/index.js";
import { publicId } from "../normalization/index.js";
import { confirmed, review, score } from "../scoring/index.js";
export const methodology =
  "Методология РАДАР М · v1\n0 — обычный фон.\n1 — шум и неподтверждённые сообщения.\n2 — слабые косвенные признаки.\n3 — несколько независимых признаков.\n4 — масштабная подтверждённая необычная активность.\n5 — новое официальное юридическое действие.\n\nПерепечатки одного сообщения — одна цепочка. Один Telegram-пост не является доказательством. Регионы оцениваются отдельно; непроверенные регионы имеют статус «нет данных». Общероссийский индекс учитывает географию, независимость и типы доказательств. Индекс не является вероятностью или прогнозом. Юридический статус хранится отдельно; старый указ не делает каждый выпуск уровнем 5.";
export function deepLink(username: string, key: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || !/^[A-Za-z0-9_]+$/.test(username))
    throw new Error("invalid_deeplink");
  return `https://t.me/${username}?start=${key}`;
}
export function makeReport(
  events: Finding[],
  articles: Article[],
  sources: Source[],
  results: CollectorResult[],
  previous: Report | null,
  c: Config,
  now = new Date(),
): Report {
  const checked = results.filter((r) => r.status === "ok").length,
    total = sources.filter((s) => s.active).length,
    ratio = total ? checked / total : 0;
  const federalSignal = score(
    events,
    ratio,
    previous?.federalSignal.level ?? null,
    c,
    true,
  );
  const regions = [
    ...new Set(
      [...sources.map((s) => s.region), ...events.map((e) => e.region)].filter(
        (r): r is string => !!r,
      ),
    ),
  ];
  const regionalSignals = Object.fromEntries(
    regions.map((region) => {
      const rs = sources.filter((s) => s.region === region && s.active);
      const rc = results.filter(
        (r) => r.status === "ok" && rs.some((s) => s.id === r.sourceId),
      ).length;
      return [
        region,
        score(
          events.filter((e) => e.region === region),
          rs.length ? rc / rs.length : 0,
          previous?.regionalSignals[region]?.level ?? null,
          c,
        ),
      ];
    }),
  );
  const snapshots: Snapshot[] = events.flatMap((e) =>
    e.evidence.map((ev) => {
      const a = articles.find((a) => a.id === ev.articleId)!;
      const s = sources.find((s) => s.id === a.source_id)!;
      return {
        articleId: a.id,
        sourceName: s.name,
        url: a.canonical_url,
        title: a.title,
        publishedAt: a.published_at,
        checkedAt: now.toISOString(),
        sourceType: s.type,
        role: ev.role,
        verificationStatus: e.verificationStatus,
        findingKey: e.canonicalKey,
        excerpt: ev.quote,
        contentHash: a.content_hash,
      };
    }),
  );
  const r: Report = {
    publicId: publicId(),
    reportDate: day(now, c.APP_TIMEZONE),
    checkedAt: now.toISOString(),
    federalSignal,
    regionalSignals,
    events,
    confirmedFacts: events.filter(confirmed),
    unverifiedClaims: events.filter((e) =>
      ["UNVERIFIED", "SINGLE_SOURCE"].includes(e.verificationStatus),
    ),
    contradictedClaims: events.filter(
      (e) => e.verificationStatus === "CONTRADICTED",
    ),
    debunkedClaims: events.filter((e) => e.verificationStatus === "DEBUNKED"),
    officialAction: {
      detected: events.some((e) => e.freshOfficial),
      events: events.filter((e) => e.freshOfficial),
    },
    whatChanged: events
      .filter((e) => e.change !== "unchanged")
      .map(
        (e) =>
          `${e.change === "confirmation" ? "Новое подтверждение" : e.change === "status_change" ? "Изменён статус" : "Новое сообщение"}: ${e.summary}`,
      ),
    coverage: { checked, total, ratio },
    runStatus: ratio < 1 ? "degraded" : "completed",
    ...review(federalSignal, events, c),
    telegramText: "",
    sources: snapshots,
  };
  r.telegramText = formatReport(r, c);
  return r;
}
export function formatReport(r: Report, c: Config): string {
  const s = r.federalSignal;
  const arrow =
    s.level === null || s.previousLevel === null
      ? "—"
      : s.level > s.previousLevel
        ? "↑"
        : s.level < s.previousLevel
          ? "↓"
          : "→";
  const cite = (e: Finding) => {
    const indices = r.sources
      .map((x, i) => (x.findingKey === e.canonicalKey ? i + 1 : 0))
      .filter(Boolean);
    return `${e.summary} [${indices.join(", ")}]`;
  };
  const pieces = [
    `📅 ${r.reportDate}`,
    `${s.level === null ? "⚪" : s.level < 2 ? "🟢" : s.level < 4 ? "🟡" : "🔴"} Индекс мобилизации: ${s.level === null ? "нет данных" : `${s.level}/5`} · ${arrow}`,
  ];
  if (s.coverage !== "checked")
    pieces.push(
      "Проверка неполная. Данных недостаточно для вывода об отсутствии изменений.",
    );
  if (r.officialAction.detected)
    pieces.push(
      "🏛 Официально\n" +
        r.officialAction.events
          .slice(0, 2)
          .map(
            (e) =>
              `${cite(e)}\nТерритория: ${e.officialScope ?? "требует уточнения"}`,
          )
          .join("\n"),
    );
  else
    pieces.push(
      "🏛 Официально\nВ проверенных материалах новых подтверждённых решений не установлено.",
    );
  const active = r.confirmedFacts.filter(
    (e) => e.change !== "unchanged" && !e.routine,
  );
  if (active.length)
    pieces.push(
      "📡 Новые подтверждённые признаки\n" +
        active.slice(0, 3).map(cite).join("\n"),
    );
  if (r.unverifiedClaims.length)
    pieces.push(
      "💬 Неподтверждённые сообщения\n" +
        r.unverifiedClaims
          .slice(0, 2)
          .map((e) => cite(e) + " — пока не подтверждено.")
          .join("\n"),
    );
  if (r.contradictedClaims.length)
    pieces.push(
      "⚠️ Противоречия\n" +
        r.contradictedClaims.slice(0, 1).map(cite).join("\n"),
    );
  if (r.debunkedClaims.length)
    pieces.push(
      "❌ Опровержения\n" + r.debunkedClaims.slice(0, 1).map(cite).join("\n"),
    );
  if (!r.whatChanged.length)
    pieces.push(
      "Новых существенных сигналов в проверенных материалах не выявлено.",
    );
  const regional = Object.entries(r.regionalSignals)
    .filter(([, s]) => (s.level ?? 0) > 0)
    .slice(0, 5);
  if (regional.length)
    pieces.push(
      "📍 " +
        regional.map(([region, s]) => `${region}: ${s.level}/5`).join("; "),
    );
  pieces.push(
    `Проверено источников: ${r.coverage.checked}/${r.coverage.total}\nОбновлено: ${new Intl.DateTimeFormat("ru-RU", { timeZone: c.APP_TIMEZONE, hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(r.checkedAt))}\nИндекс описывает сигналы, а не вероятность мобилизации.`,
  );
  return pieces.join("\n\n").slice(0, 4000);
}
export function sourcePages(report: Report): string[] {
  const groups = new Map<string, string[]>();
  report.sources.forEach((s, i) => {
    const g = ["UNVERIFIED", "SINGLE_SOURCE", "CONTRADICTED"].includes(
      s.verificationStatus,
    )
      ? "⚠️ Неподтверждённые"
      : s.sourceType.startsWith("OFFICIAL")
        ? "🏛 Официальные"
        : s.sourceType === "REGIONAL_MEDIA"
          ? "📍 Региональные"
          : "📰 СМИ и другие источники";
    const rows = groups.get(g) ?? [];
    rows.push(
      `${i + 1}. ${s.title}\n${s.sourceName} · ${s.verificationStatus}\n${s.url}\n${s.role}`,
    );
    groups.set(g, rows);
  });
  const pages: string[] = [];
  let page = `📚 Источники выпуска от ${report.reportDate}\nПроверено: ${report.checkedAt}\n`;
  for (const [g, rows] of groups)
    for (const row of rows) {
      const block = `\n${g}\n${row}\n`;
      if (page.length + block.length > 3800) {
        pages.push(page);
        page = "";
      }
      page += block;
    }
  pages.push(page || "В выпуске нет отдельных находок.");
  return pages;
}
