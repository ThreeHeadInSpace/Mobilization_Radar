import { it, expect } from "vitest";
import { TestDB } from "./db.js";
import { cfg, source, article, finding } from "./fixtures.js";
import { Worker } from "../src/jobs/worker.js";
import { Telegram } from "../src/telegram/index.js";
import { makeReport } from "../src/reports/index.js";
import { randomUUID } from "node:crypto";
const tg = new Telegram(
  cfg,
  async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
);
it("AI failure marks run failed and never stages a report", async () => {
  const db = await TestDB.create();
  try {
    await db.put("sources", source);
    const a = article();
    await db.put("articles", a);
    const worker = new Worker(db, cfg, tg, () => ({
      triage: async () => {
        throw new Error("offline");
      },
      analyze: async () => {
        throw new Error("offline");
      },
    }));
    let run = await worker.start(randomUUID(), "test");
    await db.put("run_articles", { run_id: run.id, article_id: a.id });
    await db.patch("monitor_runs", { id: run.id }, { phase: "triage" });
    run = (await db.all("monitor_runs", { id: run.id }))[0];
    await worker.step(run, new Date());
    expect((await db.all("monitor_runs", { id: run.id }))[0].status).toBe(
      "analysis_failed",
    );
    await worker.stageDaily(new Date());
    expect(await db.all("summaries")).toHaveLength(0);
  } finally {
    await db.pg.close();
  }
});
it("published snapshots remain tied to original text and inserted rows are rejected", async () => {
  const db = await TestDB.create();
  try {
    await db.put("sources", source);
    const a = article();
    await db.put("articles", a);
    const rid = randomUUID();
    await db.put("monitor_runs", {
      id: rid,
      idempotency_key: rid,
      trigger_type: "test",
      status: "completed",
    });
    const report = makeReport([finding(a)], [a], [source], [], null, cfg);
    const sid = await db.rpc("radar_stage", { p_run: rid, p_report: report });
    await db.patch(
      "articles",
      { id: a.id },
      { title: "Changed later", text: "Different text" },
    );
    expect(
      (await db.all("summary_sources", { summary_id: sid }))[0].data.title,
    ).toBe(a.title);
    await expect(
      db.put("summary_sources", { summary_id: sid, ordinal: 2, data: {} }),
    ).rejects.toThrow("immutable");
  } finally {
    await db.pg.close();
  }
});
it("reanalyze blocks old draft, preserves it, and queues a new job", async () => {
  const db = await TestDB.create();
  try {
    await db.put("sources", source);
    const rid = randomUUID();
    await db.put("monitor_runs", {
      id: rid,
      idempotency_key: rid,
      trigger_type: "test",
      status: "completed",
    });
    const report = makeReport([], [], [source], [], null, cfg);
    const sid = await db.rpc("radar_stage", { p_run: rid, p_report: report });
    expect(
      await db.rpc("radar_admin", {
        p_public: report.publicId,
        p_action: "reanalyze",
        p_actor: "11",
        p_key: "reanalyze-1",
      }),
    ).toBe("queued");
    expect(
      (await db.all("publication_queue", { summary_id: sid }))[0].status,
    ).toBe("rejected");
    expect((await db.all("admin_jobs"))[0].status).toBe("pending");
    expect((await db.all("summaries", { id: sid }))[0].data.publicId).toBe(
      report.publicId,
    );
  } finally {
    await db.pg.close();
  }
});
it("monthly usage sums all requests and exposes unknown cost", async () => {
  const db = await TestDB.create();
  try {
    for (const cost of [0.1, 0.2, null])
      await db.put("ai_usage", {
        provider: "xai",
        model: "fixture",
        operation: "triage",
        cost,
        duration: 1,
        success: true,
      });
    const r = await db.rpc("radar_monthly_usage", {
      p_month: new Date().toISOString().slice(0, 7) + "-01",
    });
    expect(Number(r.total)).toBeCloseTo(0.3);
    expect(r.unknownCost).toBe(1);
  } finally {
    await db.pg.close();
  }
});
