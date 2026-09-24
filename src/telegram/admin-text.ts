import type { Report } from "../domain.js";
export const adminText = {
  button: "🔎 Запустить внеочередную проверку",
  confirm:
    "Запустить внеочередную проверку? Я заново проверю источники и выполню анализ. Плановые проверки продолжат работать по обычному расписанию.",
  busy: "🔎 Я уже в работе. Сейчас проверяю источники и ищу новую информацию.\n\nКогда закончу, пришлю результат сюда. Если после этого понадобится ещё одна проверка, её можно будет запустить снова.",
  started:
    "📡 Начинаю внеочередную проверку. Проверю источники, новые публикации и изменения с последнего анализа. Результат пришлю сюда.",
  cancelled: "Внеочередная проверка отменена.",
  expired:
    "Подтверждение недействительно или истекло. Запустите проверку заново через меню.",
  duplicate: "Это подтверждение уже обработано.",
  failed:
    "Внеочередная проверка не завершена: анализ недоступен. Результат не публиковался. Проверку можно запустить снова.",
};
export const adminMenu = {
  keyboard: [[{ text: adminText.button }]],
  resize_keyboard: true,
  is_persistent: true,
};
// Independent from public report formatting; all sections are private and paginated.
export function manualReportPages(r: Report, manual = true): string[] {
  const s = r.federalSignal;
  const delta =
    s.level === null || s.previousLevel === null
      ? "нет сопоставимых данных"
      : `${s.level - s.previousLevel > 0 ? "+" : ""}${s.level - s.previousLevel}`;
  const blocks = [
    `🔎 ${manual ? "Внеочередная проверка" : "Текущая проверка"} завершена · ${r.checkedAt}\nПриватный результат для администратора${manual ? " · review-only" : ""}\nФедеральный индекс: ${s.level ?? "нет данных"}\nПредыдущий опубликованный индекс: ${s.previousLevel ?? "нет данных"}\nДинамика: ${delta}\nCoverage: ${r.coverage.checked}/${r.coverage.total} (${Math.round(r.coverage.ratio * 100)}%)\nНезависимых информационных цепочек: ${new Set(r.events.flatMap((e) => e.chains)).size}`,
    `Что изменилось:\n${r.whatChanged.join("\n") || "Новых изменений не выявлено в проверенных материалах."}`,
    `Причины индекса:\n${s.reasons.join("\n") || "Недостаточно данных."}`,
    `Регионы:\n${
      Object.entries(r.regionalSignals)
        .map(([name, value]) => `${name}: ${value.level ?? "нет данных"}`)
        .join("\n") || "Нет отдельных региональных сигналов."
    }`,
    "Значимые findings:",
    ...(r.events.length
      ? r.events.map(
          (e) =>
            `${e.summary}\n${e.verificationStatus} · ${e.change} · ${e.region ?? "федеральный уровень"}`,
        )
      : ["Нет отдельных находок."]),
    `Ограничения:\n${r.reviewReasons.join("\n") || "Нет дополнительных ограничений."}`,
    "Источники:",
    ...(r.sources.length
      ? r.sources.map(
          (s) =>
            `${s.sourceName} · ${s.verificationStatus}\n${s.title}\n${s.url}`,
        )
      : ["Источники отдельных находок отсутствуют."]),
  ];
  const pages: string[] = [];
  let page = "";
  for (const block of blocks)
    for (let i = 0; i < block.length; i += 3500) {
      const part = block.slice(i, i + 3500);
      if (page.length + part.length + 2 > 3800) {
        pages.push(page);
        page = "";
      }
      page += (page ? "\n\n" : "") + part;
    }
  if (page) pages.push(page);
  return pages;
}
