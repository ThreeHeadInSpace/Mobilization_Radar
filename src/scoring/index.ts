import type { Config } from "../config/index.js";
import type { Finding, Signal } from "../domain.js";
export const confirmed = (e: Finding) =>
  ["CONFIRMED_PRIMARY", "CONFIRMED_MULTI_SOURCE"].includes(
    e.verificationStatus,
  );
export function score(
  events: Finding[],
  coverage: number,
  previous: number | null,
  c: Config,
  federal = false,
): Signal {
  const active = events.filter(
    (e) =>
      !e.routine &&
      e.change !== "unchanged" &&
      !["DEBUNKED", "CONTRADICTED"].includes(e.verificationStatus),
  );
  const reliable = active.filter((e) => confirmed(e) && e.unusual);
  const chains = new Set(reliable.flatMap((e) => e.chains));
  const types = new Set(reliable.flatMap((e) => e.evidenceTypes));
  const regions = new Set(reliable.map((e) => e.region).filter(Boolean));
  let level = active.length ? 1 : 0;
  const reasons: string[] = [];
  if (reliable.length) {
    level = 2;
    reasons.push("Есть подтверждённый необычный факт.");
  }
  if (chains.size >= 2) {
    level = 3;
    reasons.push("Есть как минимум две независимые цепочки подтверждения.");
  }
  if (
    chains.size >= c.STRONG_CHAINS &&
    types.size >= 2 &&
    reliable.some((e) => e.mass && e.municipalities.length >= 2)
  ) {
    level = 4;
    reasons.push(
      "Подтверждена массовая необычная активность в нескольких муниципалитетах.",
    );
  }
  if (
    federal &&
    regions.size < c.FEDERAL_REGIONS &&
    reliable.every((e) => e.region !== null)
  )
    level = Math.min(level, 2);
  if (
    active.some(
      (e) =>
        e.freshOfficial &&
        (!federal || e.officialScope === "Российская Федерация"),
    )
  ) {
    level = 5;
    reasons.push(
      "Свежий официальный первоисточник о новом юридическом действии; требуется critical review.",
    );
  }
  reasons.push(
    `Независимых цепочек: ${chains.size}; типов доказательств: ${types.size}; регионов: ${regions.size}.`,
  );
  if (coverage < c.MIN_COVERAGE)
    reasons.push(
      "Недостаточная полнота проверки; отсутствие сообщений не означает отсутствие событий.",
    );
  return {
    level: coverage < c.MIN_COVERAGE && level === 0 ? null : level,
    previousLevel: previous,
    confidence:
      coverage < c.MIN_COVERAGE
        ? "low"
        : active.some((e) => !confirmed(e))
          ? "medium"
          : "high",
    reasons,
    coverage:
      coverage === 0
        ? "unknown"
        : coverage < c.MIN_COVERAGE
          ? "partial"
          : "checked",
  };
}
export function review(signal: Signal, events: Finding[], c: Config) {
  const reasons: string[] = [];
  if (c.REQUIRE_REVIEW_ALL) reasons.push("Включена проверка всех выпусков.");
  if (!c.AUTO_PUBLISH_SAFE_REPORTS) reasons.push("Автопубликация отключена.");
  if (signal.level === null || signal.coverage !== "checked")
    reasons.push("Недостаточное покрытие.");
  if (signal.level !== null && signal.level >= c.REVIEW_LEVEL)
    reasons.push("Индекс достиг порога ручной проверки.");
  if (signal.confidence !== "high") reasons.push("Уверенность ниже высокой.");
  if (events.some((e) => e.verificationStatus === "CONTRADICTED"))
    reasons.push("Противоречивые источники.");
  const critical = events.some((e) => e.officialAction !== "none");
  if (critical) reasons.push("Необходима проверка юридического действия.");
  return {
    reviewRequired: reasons.length > 0,
    reviewState: critical
      ? "CRITICAL_REVIEW"
      : reasons.length
        ? "REVIEW_REQUIRED"
        : signal.level === 1
          ? "WATCH"
          : "NORMAL",
    reviewReasons: reasons,
  };
}
