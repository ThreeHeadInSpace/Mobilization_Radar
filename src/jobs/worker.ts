import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import { day, clock } from "../config/index.js";
import type { DB } from "../database/index.js";
import {
  type Article,
  type Source,
  type Finding,
  type CollectorResult,
  type Report,
  analysisSchema,
} from "../domain.js";
import { collect, parsePage } from "../collectors/index.js";
import { getText } from "../collectors/http.js";
import { normalizeUrl, hash } from "../normalization/index.js";
import { verifyFindings } from "../intelligence/index.js";
import { makeReport } from "../reports/index.js";
import type { AIProvider } from "../providers/ai-provider.js";
import { XAIProvider } from "../providers/xai-provider.js";
import { Telegram, publish } from "../telegram/index.js";
import { adminText, manualReportPages } from "../telegram/admin-text.js";
import { nextScheduledKey } from "./schedule.js";
export class Worker {
  constructor(
    private db: DB,
    private c: Config,
    private tg: Telegram,
    private makeAI?: (runId: string) => AIProvider,
    private collector = collect,
  ) {}
  async notify(text: string) {
    await this.tg.send(this.c.TELEGRAM_ADMIN_CHAT_ID, text).catch(() => {});
  }
  ai(runId: string): AIProvider {
    return (
      this.makeAI?.(runId) ??
      new XAIProvider(this.c, async (u) => {
        await this.db.put("ai_usage", { ...u, run_id: runId });
      })
    );
  }
  async start(key: string, trigger = "scheduled") {
    const existing = (
      await this.db.all("monitor_runs", { idempotency_key: key })
    )[0];
    if (existing) return existing;
    const active = (
      await this.db.all("monitor_runs", { status: "running" })
    )[0];
    if (active) return active;
    const previous = (
      await this.db.all("monitor_runs", {}, "started_at", 1)
    )[0];
    try {
      return await this.db.put("monitor_runs", {
        id: randomUUID(),
        idempotency_key: key,
        trigger_type: trigger,
        previous_run_id: previous?.id ?? null,
        state: {},
      });
    } catch (error) {
      // A manual RPC can win between our reads and insert. Resume the winner.
      const winner =
        (await this.db.all("monitor_runs", { status: "running" }))[0] ??
        (await this.db.all("monitor_runs", { idempotency_key: key }))[0];
      if (winner) return winner;
      throw error;
    }
  }
  async tick(now = new Date(), force = false) {
    const owner = randomUUID();
    if (
      !(await this.db.rpc("radar_lock", {
        p_name: "worker",
        p_owner: owner,
        p_seconds: 240,
      }))
    )
      return { status: "busy" };
    try {
      await this.deliverManualResults();
      // A process crash after sendMessage is also ambiguous, never ready again.
      for (const q of await this.db.all("publication_queue", {
        status: "sending",
      }))
        if (Date.parse(q.started_at) < now.getTime() - 240000) {
          await this.db.patch(
            "publication_queue",
            { summary_id: q.summary_id, status: "sending" },
            { status: "unknown" },
          );
          await this.notify(
            "Отправка прервана. Проверьте канал: автоматический повтор заблокирован.",
          );
        }
      for (const q of await this.db.all("publication_queue", {
        status: "ready",
      })) {
        const s = (await this.db.all("summaries", { id: q.summary_id }))[0];
        await publish(this.db, this.tg, this.c, s);
        return { status: "publication_processed" };
      }
      for (const q of await this.db.all("publication_queue", {
        status: "review",
      })) {
        const key = `review-notified:${q.summary_id}`;
        if (!(await this.db.all("audit_log", { action_key: key })).length) {
          try {
            const s = (await this.db.all("summaries", { id: q.summary_id }))[0];
            await this.tg.notifyReview(s.data);
            await this.db.put("audit_log", {
              action_key: key,
              action: "review_notified",
              actor: "system",
              data: { summary_id: s.id },
            });
          } catch {
            /* Retry private notification on next tick. */
          }
          break;
        }
      }
      let run = (await this.db.all("monitor_runs", { status: "running" }))[0];
      if (!run) {
        const job = (
          await this.db.all(
            "admin_jobs",
            { status: "pending" },
            "created_at",
            1,
          )
        )[0];
        if (job) {
          run = await this.start(`review:${job.id}`, "reanalyze");
          if (run.idempotency_key === `review:${job.id}`) {
            const summary = (
              await this.db.all("summaries", { id: job.summary_id })
            )[0];
            for (const snapshot of summary.data.sources) {
              await this.db.put(
                "run_articles",
                { run_id: run.id, article_id: snapshot.articleId },
                "run_id,article_id",
              );
            }
            await this.db.patch(
              "admin_jobs",
              { id: job.id },
              { status: "running" },
            );
            await this.db.patch(
              "monitor_runs",
              { id: run.id },
              { state: { adminJob: job.id, summaryId: job.summary_id } },
            );
            run.state = { adminJob: job.id, summaryId: job.summary_id };
          }
        }
      }
      if (!run) {
        const slot = nextScheduledKey(
          this.c,
          now,
          await this.db.all("monitor_runs", {}, "started_at", 1000),
        );
        if (force || slot)
          run = await this.start(
            force ? `${day(now, this.c.APP_TIMEZONE)}:manual` : slot!,
            force ? "manual" : "scheduled",
          );
      }
      if (run?.status === "running") await this.step(run, now);
      await this.deliverManualResults();
      if (clock(now, this.c.APP_TIMEZONE) >= this.c.PUBLICATION_TIME)
        await this.stageDaily(now);
      await this.warnBudget(now);
      return { status: "ok", phase: run?.phase ?? "idle" };
    } finally {
      await this.db.rpc("radar_unlock", { p_name: "worker", p_owner: owner });
    }
  }
  async saveArticles(runId: string, articles: Article[]) {
    for (const a of articles) {
      const known =
        (
          await this.db.all("articles", { canonical_url: a.canonical_url })
        )[0] ??
        (await this.db.all("articles", { content_hash: a.content_hash }))[0];
      if (known?.content_hash === a.content_hash) continue;
      const next = known
        ? { ...a, id: known.id, discovered_at: known.discovered_at }
        : a;
      await this.db.put("articles", next, known ? "canonical_url" : undefined);
      await this.db.put(
        "run_articles",
        { run_id: runId, article_id: next.id },
        "run_id,article_id",
      );
    }
  }
  async step(run: any, now: Date) {
    const sources: Source[] = await this.db.all("sources", { active: true });
    const state = run.state ?? {};
    try {
      if (run.phase === "collect") {
        const done = await this.db.all("collector_runs", { run_id: run.id });
        const pending = sources
          .filter((s) => !done.some((d) => d.source_id === s.id))
          .slice(0, 3);
        if (pending.length) {
          const results = await Promise.all(
            pending.map((s) => this.collector(s)),
          );
          for (const result of results) {
            await this.saveArticles(run.id, result.articles);
            await this.db.put(
              "collector_runs",
              {
                run_id: run.id,
                source_id: result.sourceId,
                result: { ...result, articles: [] },
              },
              "run_id,source_id",
            );
          }
          return;
        }
        await this.db.patch(
          "monitor_runs",
          { id: run.id },
          {
            phase: this.c.ENABLE_WEB_SEARCH ? "discover" : "triage",
            collector_errors: done
              .filter((d) => d.result.status !== "ok")
              .map((d) => ({
                sourceId: d.source_id,
                status: d.result.status,
                errorCode: d.result.errorCode,
              })),
            items_checked: done.reduce(
              (n, d) => n + d.result.itemsDiscovered,
              0,
            ),
          },
        );
        return;
      }
      if (run.phase === "discover") {
        try {
          state.discoveryUrls = (await this.ai(run.id).search?.()) ?? [];
        } catch {
          state.discoveryError = true;
          state.discoveryUrls = [];
        }
        await this.db.patch(
          "monitor_runs",
          { id: run.id },
          { phase: "discovery_fetch", state },
        );
        return;
      }
      if (run.phase === "discovery_fetch") {
        const raw = state.discoveryUrls?.shift();
        if (raw) {
          try {
            const url = normalizeUrl(raw);
            let source = sources.find(
              (s) => new URL(s.base_url).hostname === new URL(url).hostname,
            );
            if (!source) {
              source = {
                id: `discovery-${hash(new URL(url).hostname).slice(0, 16)}`,
                name: new URL(url).hostname,
                type: "OTHER",
                base_url: new URL(url).origin,
                region: null,
                collection_method: "html",
                active: false,
                reliability_metadata: { discovered: true },
              };
              await this.db.put("sources", source, "id");
            }
            const a = parsePage((await getText(url)).text, source, url);
            if (a) await this.saveArticles(run.id, [a]);
          } catch {
            state.discoveryError = true;
          }
          await this.db.patch("monitor_runs", { id: run.id }, { state });
          return;
        }
        await this.db.patch(
          "monitor_runs",
          { id: run.id },
          { phase: "triage", state },
        );
        return;
      }
      if (run.phase === "triage") {
        const rows = await this.db.all("run_articles", { run_id: run.id });
        const pending = rows.filter((r) => !r.triage).slice(0, 3);
        if (pending.length) {
          await Promise.all(
            pending.map(async (row) => {
              const a = (
                await this.db.all("articles", { id: row.article_id })
              )[0];
              const triage = await this.ai(run.id).triage(a);
              await this.db.patch(
                "run_articles",
                { run_id: run.id, article_id: a.id },
                { triage },
              );
            }),
          );
          return;
        }
        await this.db.patch(
          "monitor_runs",
          { id: run.id },
          { phase: "analyze", items_new: rows.length },
        );
        return;
      }
      if (run.phase === "analyze") {
        const rows = await this.db.all("run_articles", { run_id: run.id });
        const relevant = rows.filter((r) => r.triage?.relevant);
        // Bound synthesis batches; persisted partials make the function resumable.
        const offset = state.offset ?? 0;
        const batch = relevant.slice(offset, offset + 12);
        const history: Finding[] = (
          await this.db.all("findings", {}, "last_seen_at", 200)
        ).map((x) => x.data);
        if (batch.length) {
          const articles: Article[] = await Promise.all(
            batch.map(
              async (r) =>
                (await this.db.all("articles", { id: r.article_id }))[0],
            ),
          );
          const raw = analysisSchema.parse(
            await this.ai(run.id).analyze(articles, [
              ...history,
              ...(state.findings ?? []),
            ]),
          );
          const verified = verifyFindings(
            raw,
            articles,
            await this.db.all("sources"),
            [...history, ...(state.findings ?? [])],
            now,
          );
          await this.db.patch(
            "monitor_runs",
            { id: run.id },
            {
              state: {
                ...state,
                offset: offset + batch.length,
                findings: [...(state.findings ?? []), ...verified],
              },
            },
          );
          return;
        }
        const events: Finding[] = state.findings ?? [];
        const articleIds = [
          ...new Set(
            events.flatMap((e) => e.evidence.map((ev) => ev.articleId)),
          ),
        ];
        const articles: Article[] = await Promise.all(
          articleIds.map(
            async (id) => (await this.db.all("articles", { id }))[0],
          ),
        );
        const results: CollectorResult[] = (
          await this.db.all("collector_runs", { run_id: run.id })
        ).map((r) => r.result);
        const previous = await this.previousPublished();
        const report = makeReport(
          events,
          articles,
          await this.db.all("sources"),
          results,
          previous,
          this.c,
          now,
        );
        if (state.discoveryError) {
          report.reviewRequired = true;
          report.reviewState = "REVIEW_REQUIRED";
          report.reviewReasons.push("Web discovery недоступен.");
          report.runStatus = "degraded";
        }
        if (run.trigger_type === "manual-review") {
          report.reviewRequired = true;
          report.reviewState = "REVIEW_REQUIRED";
          report.reviewReasons.push(
            "Внеочередная проверка: только для администратора, без публикации.",
          );
        }
        await this.db.rpc("radar_save_report", {
          p_run: run.id,
          p_report: report,
        });
        if (report.coverage.ratio < this.c.MIN_COVERAGE)
          await this.notify(
            `РАДАР М: неполная проверка ${report.coverage.checked}/${report.coverage.total}. Вывод «всё спокойно» недопустим.`,
          );
        if (state.adminJob) {
          await this.db.patch(
            "admin_jobs",
            { id: state.adminJob },
            { status: "completed" },
          );
          await this.db.patch(
            "summaries",
            { id: state.summaryId, superseded: false },
            { superseded: true },
          );
          await this.notify(
            `Повторный анализ завершён. Предыдущий черновик сохранён в архиве. Новый выпуск будет направлен на проверку.`,
          );
        }
      }
    } catch {
      await this.db.patch(
        "monitor_runs",
        { id: run.id },
        { status: "analysis_failed", finished_at: now.toISOString() },
      );
      await this.notify(
        "РАДАР М: анализ не завершён. Сводка этого запуска не публикуется. Проверьте состояние запуска и доступность провайдера.",
      );
    }
  }
  async previousPublished(): Promise<Report | null> {
    const summaries = await this.db.all("summaries", {}, "published_at", 100);
    return (
      summaries
        .filter((s) => s.published_at)
        .sort(
          (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at),
        )[0]?.data ?? null
    );
  }
  async deliverManualResults() {
    const requested = await this.db.all(
      "manual_review_requests",
      { status: "already_running" },
      "created_at",
      1000,
    );
    const runs = (
      await this.db.all("monitor_runs", {}, "started_at", 1000)
    ).filter(
      (r) =>
        r.trigger_type === "manual-review" ||
        requested.some((q) => q.run_id === r.id),
    );
    for (const run of runs) {
      if (run.status === "running" || run.state?.manualDelivered) continue;
      const report = (await this.db.all("run_reports", { run_id: run.id }))[0]
        ?.data;
      const pages = report
        ? manualReportPages(report, run.trigger_type === "manual-review")
        : run.status === "analysis_failed"
          ? [adminText.failed]
          : [];
      const state = { ...run.state };
      try {
        const end = Math.min((state.manualPage ?? 0) + 3, pages.length);
        for (let i = state.manualPage ?? 0; i < end; i++) {
          await this.tg.send(this.c.TELEGRAM_ADMIN_CHAT_ID, pages[i]);
          state.manualPage = i + 1;
          await this.db.patch("monitor_runs", { id: run.id }, { state });
        }
        if (pages.length && state.manualPage === pages.length)
          await this.db.patch(
            "monitor_runs",
            { id: run.id },
            { state: { ...state, manualDelivered: true } },
          );
      } catch {
        /* Retry private delivery on the next tick, without rerunning AI. */
      }
      // Bound private sends per tick so delivery cannot monopolize the worker lease.
      if (pages.length) return;
    }
  }
  async stageDaily(now: Date) {
    const date = day(now, this.c.APP_TIMEZONE);
    if (
      (await this.db.all("summaries", { report_date: date, superseded: false }))
        .length
    )
      return;
    const runs = await this.db.all("monitor_runs", {}, "started_at", 50);
    const latest = runs.find((r) => r.trigger_type !== "manual-review");
    if (
      !latest ||
      latest.status === "running" ||
      latest.status === "analysis_failed"
    )
      return;
    const reports = (
      await this.db.all("run_reports", {}, "created_at", 50)
    ).filter(
      (r) =>
        runs.some(
          (run) => run.id === r.run_id && run.trigger_type !== "manual-review",
        ) &&
        day(new Date(r.created_at), this.c.APP_TIMEZONE) === date &&
        (latest.trigger_type !== "reanalyze" || r.run_id === latest.id),
    );
    if (!reports.length) return;
    const events = new Map<string, Finding>();
    for (const row of [...reports].reverse())
      for (const event of (row.data as Report).events) {
        const old = events.get(event.canonicalKey);
        events.set(event.canonicalKey, {
          ...event,
          change: old?.change === "new" ? "new" : event.change,
        });
      }
    const values = [...events.values()];
    const ids = [
      ...new Set(values.flatMap((e) => e.evidence.map((ev) => ev.articleId))),
    ];
    const articles = await Promise.all(
      ids.map(async (id) => (await this.db.all("articles", { id }))[0]),
    );
    const results = (
      await this.db.all("collector_runs", { run_id: latest.id })
    ).map((r) => r.result);
    const report = makeReport(
      values,
      articles,
      await this.db.all("sources"),
      results,
      await this.previousPublished(),
      this.c,
      now,
    );
    // Reuse the material as checked in its original run, even if an article changed later.
    const savedSources = reports.flatMap((r) => (r.data as Report).sources);
    report.sources = report.sources.map(
      (snapshot) =>
        savedSources.find(
          (old) =>
            old.articleId === snapshot.articleId &&
            old.findingKey === snapshot.findingKey &&
            old.excerpt === snapshot.excerpt,
        ) ?? snapshot,
    );
    if (
      reports.some((r) =>
        r.data.reviewReasons.includes("Web discovery недоступен."),
      )
    ) {
      report.reviewRequired = true;
      report.reviewState = "REVIEW_REQUIRED";
      report.reviewReasons.push("Web discovery недоступен.");
      report.runStatus = "degraded";
    }
    await this.db.rpc("radar_stage", { p_run: latest.id, p_report: report });
  }
  async warnBudget(now: Date) {
    const month = now.toISOString().slice(0, 7);
    const usage = await this.db.rpc("radar_monthly_usage", {
      p_month: `${month}-01`,
    });
    const sum = Number(usage.total);
    const key = `budget:${month}`;
    if (
      this.c.MONTHLY_AI_BUDGET_USD > 0 &&
      sum >= this.c.MONTHLY_AI_BUDGET_USD * 0.8 &&
      !(await this.db.all("audit_log", { action_key: key })).length
    ) {
      await this.notify(
        `Расход xAI приблизился к месячному бюджету: учтено $${sum.toFixed(2)}. Безопасность и review остаются включены.`,
      );
      await this.db.put("audit_log", {
        action_key: key,
        action: "budget_warning",
        actor: "system",
        data: { sum },
      });
    }
  }
}
