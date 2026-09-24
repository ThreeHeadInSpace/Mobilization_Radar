import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { TestDB } from "./db.js";
import { cfg, source, article, finding } from "./fixtures.js";
import { Telegram, handleUpdate } from "../src/telegram/index.js";
import { adminText, manualReportPages } from "../src/telegram/admin-text.js";
import { manualReview } from "../src/jobs/manual-review.js";
import { nextScheduledKey } from "../src/jobs/schedule.js";
import { Worker } from "../src/jobs/worker.js";
import { route } from "../src/http.js";
import { SupabaseDB } from "../src/database/index.js";
import { makeReport } from "../src/reports/index.js";
import handler from "../api/manual-review.js";
let db: TestDB;
let sent: any[];
let tg: Telegram;
beforeEach(async () => {
  db = await TestDB.create();
  sent = [];
  tg = new Telegram(cfg, async (url, init) => {
    sent.push({
      method: String(url).split("/").at(-1),
      ...JSON.parse(String(init?.body)),
    });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
    );
  });
}, 30000);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.pg.close();
});
const message = (text: string, id = 11, from = id, type = "private") => ({
  message: { message_id: 1, chat: { id, type }, from: { id: from }, text },
});
const callback = (data: string, id = "cb", from = 11) => ({
  callback_query: {
    id,
    data,
    from: { id: from },
    message: { message_id: 1, chat: { id: 11, type: "private" } },
  },
});
async function prepare() {
  await handleUpdate(db, tg, cfg, message(adminText.button));
  return sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data as string;
}
it("only authorized private admin sees menu and may request confirmation", async () => {
  await handleUpdate(db, tg, cfg, message("/start", 99));
  expect(sent.at(-1).reply_markup).toBeUndefined();
  await handleUpdate(db, tg, cfg, message("/start"));
  expect(sent.at(-1).reply_markup.keyboard[0][0].text).toBe(adminText.button);
  await handleUpdate(db, tg, cfg, message(adminText.button, 99));
  await handleUpdate(db, tg, cfg, message(adminText.button, 11, 99));
  await handleUpdate(db, tg, cfg, message(adminText.button, 11, 11, "group"));
  await handleUpdate(
    db,
    tg,
    { ...cfg, TELEGRAM_OWNER_ID: "22" },
    message(adminText.button),
  );
  expect(await db.all("manual_review_requests")).toHaveLength(0);
  const data = await prepare();
  expect(sent.at(-1).text).toBe(adminText.confirm);
  expect(await db.all("monitor_runs")).toHaveLength(0);
  await handleUpdate(db, tg, cfg, callback(data, "forged", 99));
  expect(await db.all("monitor_runs")).toHaveLength(0);
});
it("confirmation creates one running manual-review and duplicate callback never creates another, even after completion", async () => {
  const data = await prepare();
  await handleUpdate(db, tg, cfg, callback(data));
  let runs = await db.all("monitor_runs");
  expect(runs).toHaveLength(1);
  expect(runs[0].trigger_type).toBe("manual-review");
  expect(runs[0].state.reviewOnly).toBe(true);
  expect(sent.at(-1).text).toBe(adminText.started);
  await db.patch("monitor_runs", { id: runs[0].id }, { status: "completed" });
  await handleUpdate(db, tg, cfg, callback(data, "different-callback-id"));
  expect(await db.all("monitor_runs")).toHaveLength(1);
  expect(sent.at(-1).text).toBe(adminText.duplicate);
  expect(await db.all("admin_jobs")).toHaveLength(0);
});
it("cancel and expired or invented confirmations cannot start a run", async () => {
  const data = await prepare();
  await handleUpdate(
    db,
    tg,
    cfg,
    callback(data.replace(":confirm:", ":cancel:")),
  );
  expect(sent.at(-1).text).toBe(adminText.cancelled);
  await handleUpdate(db, tg, cfg, callback(data));
  expect(await db.all("monitor_runs")).toHaveLength(0);
  const token = randomUUID();
  await manualReview(db, "prepare", token, "11");
  await db.patch(
    "manual_review_requests",
    { token },
    { expires_at: "2000-01-01T00:00:00Z" },
  );
  expect((await manualReview(db, "confirm", token, "11")).status).toBe(
    "expired",
  );
  expect((await manualReview(db, "confirm", randomUUID(), "11")).status).toBe(
    "invalid_confirmation",
  );
  expect(await db.all("monitor_runs")).toHaveLength(0);
});
it("active scheduled run blocks prepare and confirm without queued job or AI usage; blocked confirmation stays consumed", async () => {
  const data = await prepare();
  const active: any = await db.put("monitor_runs", {
    idempotency_key: "scheduled-test",
    trigger_type: "scheduled",
  });
  await handleUpdate(db, tg, cfg, message(adminText.button));
  expect(sent.at(-1).text).toBe(adminText.busy);
  await handleUpdate(db, tg, cfg, callback(data));
  expect(sent.at(-1).text).toBe(adminText.busy);
  expect(await db.all("monitor_runs")).toHaveLength(1);
  expect(await db.all("admin_jobs")).toHaveLength(0);
  expect(await db.all("ai_usage")).toHaveLength(0);
  await db.patch("monitor_runs", { id: active.id }, { status: "completed" });
  await handleUpdate(db, tg, cfg, callback(data, "retry"));
  expect(await db.all("monitor_runs")).toHaveLength(1);
});
it("simultaneous confirmations have only one winner and no deferred manual job", async () => {
  const a = randomUUID(),
    b = randomUUID();
  await manualReview(db, "prepare", a, "11");
  await manualReview(db, "prepare", b, "11");
  const results = await Promise.all([
    manualReview(db, "confirm", a, "11"),
    manualReview(db, "confirm", b, "11"),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([
    "already_running",
    "started",
  ]);
  expect(await db.all("monitor_runs")).toHaveLength(1);
  expect(await db.all("admin_jobs")).toHaveLength(0);
});
it("endpoint authorizes before IO, supports idempotency and has no-store safe response", async () => {
  for (const [k, v] of Object.entries({
    ...cfg,
    CRON_SECRET: "test-cron-secret-at-least-24",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "test-only-key",
  }))
    vi.stubEnv(k, String(v));
  const network = vi.fn(async () => {
    throw new Error("must not call");
  });
  vi.stubGlobal("fetch", network);
  expect((await route("/api/manual-review", "POST", {}, {})).status).toBe(401);
  expect((await route("/api/manual-review", "GET", {}, {})).status).toBe(405);
  expect(network).not.toHaveBeenCalled();
  const rpc = vi
    .spyOn(SupabaseDB.prototype, "rpc")
    .mockImplementation((name, args) => db.rpc(name, args));
  vi.spyOn(Telegram.prototype, "send").mockResolvedValue({ message_id: 1 });
  const headers = {
    authorization: "Bearer test-cron-secret-at-least-24",
    "idempotency-key": randomUUID(),
  };
  const first = await route("/api/manual-review", "POST", headers, {});
  expect(first.status).toBe(200);
  expect(first.body).toEqual({
    ok: true,
    status: "started",
    runId: expect.any(String),
  });
  expect((await route("/api/manual-review", "POST", headers, {})).body).toEqual(
    first.body,
  );
  expect(
    (
      await route(
        "/api/manual-review",
        "POST",
        { ...headers, "idempotency-key": randomUUID() },
        {},
      )
    ).body,
  ).toEqual({ ok: true, status: "already_running" });
  const calls = rpc.mock.calls.length;
  expect(
    (
      await route(
        "/api/manual-review",
        "POST",
        { ...headers, "idempotency-key": "bad" },
        {},
      )
    ).status,
  ).toBe(400);
  expect(rpc.mock.calls).toHaveLength(calls);
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  await handler({ method: "POST", headers: {} }, res);
  expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
});
it("full manual pipeline saves review-only report, privately delivers all sections, never stages, and leaves scheduled slot available", async () => {
  const c = {
    ...cfg,
    ENABLE_WEB_SEARCH: true,
    REQUIRE_REVIEW_ALL: false,
    AUTO_PUBLISH_SAFE_REPORTS: true,
    APP_TIMEZONE: "UTC",
    MONITOR_HOURS: "08,15",
    PUBLICATION_TIME: "00:00",
  };
  const a = article();
  await db.put("sources", source);
  const triage = vi.fn(async () => ({
    relevant: true,
    eventType: "unusual_summons",
    region: source.region,
    sourceRole: "primary" as const,
    primarySourceLikelihood: "high" as const,
    novelty: "new" as const,
    verificationHint: "fixture",
    needsDeepAnalysis: true,
  }));
  const analyze = vi.fn(async () => {
    const { chains, evidenceTypes, change, freshOfficial, ...event } =
      finding(a);
    return { events: [event], limitations: [] };
  });
  const search = vi.fn(async () => []);
  const worker = new Worker(
    db,
    c,
    tg,
    () => ({ triage, analyze, search }),
    async () => ({
      sourceId: source.id,
      status: "ok",
      httpCode: 200,
      errorCode: null,
      duration: 1,
      itemsDiscovered: 1,
      retryCount: 0,
      articles: [a, a],
    }),
  );
  const result = await manualReview(db, "direct", randomUUID(), "api");
  const now = new Date("2026-09-25T15:05:00Z");
  for (let i = 0; i < 16; i++) {
    await worker.tick(now);
    if (
      (await db.all("monitor_runs", { id: result.runId }))[0].status !==
      "running"
    )
      break;
  }
  const run = (await db.all("monitor_runs", { id: result.runId }))[0];
  expect(run.status).toBe("completed");
  expect(triage).toHaveBeenCalledTimes(1);
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(search).toHaveBeenCalledTimes(1);
  const report = (await db.all("run_reports", { run_id: run.id }))[0].data;
  expect(report.reviewRequired).toBe(true);
  expect(report.reviewState).toBe("REVIEW_REQUIRED");
  expect(await db.all("summaries")).toHaveLength(0);
  expect(await db.all("publication_queue")).toHaveLength(0);
  await expect(
    db.rpc("radar_stage", { p_run: run.id, p_report: report }),
  ).rejects.toThrow("manual_review_is_private");
  const sends = sent.filter((s) => s.method === "sendMessage");
  expect(sends.every((s) => s.chat_id === cfg.TELEGRAM_ADMIN_CHAT_ID)).toBe(
    true,
  );
  const text = sends.map((s) => s.text).join("\n");
  for (const section of [
    "Федеральный индекс",
    "Предыдущий опубликованный индекс",
    "Динамика",
    "Что изменилось",
    "findings",
    "Регионы",
    "Coverage",
    "Причины индекса",
    "Независимых информационных цепочек",
    "Источники",
    "example.org",
  ])
    expect(text).toContain(section);
  const count = sent.length;
  await worker.deliverManualResults();
  expect(sent).toHaveLength(count);
  await worker.tick(now);
  const scheduled = (
    await db.all("monitor_runs", { trigger_type: "scheduled" })
  )[0];
  expect(scheduled.idempotency_key).toBe("2026-09-25:08:00");
  expect(c.MONITOR_HOURS).toBe("08,15");
  expect(c.PUBLICATION_TIME).toBe("00:00");
}, 30000);
it("missed scheduled slots survive a manual run across midnight and completed keys are not repeated", () => {
  const c = { ...cfg, APP_TIMEZONE: "UTC", MONITOR_HOURS: "08,15" };
  const runs = [
    {
      trigger_type: "manual-review",
      started_at: "2026-09-24T14:00:00Z",
      finished_at: "2026-09-25T01:00:00Z",
    },
  ];
  expect(nextScheduledKey(c, new Date("2026-09-25T01:01:00Z"), runs)).toBe(
    "2026-09-24:15:00",
  );
  expect(
    nextScheduledKey(c, new Date("2026-09-25T01:01:00Z"), [
      ...runs,
      { trigger_type: "scheduled", idempotency_key: "2026-09-24:15:00" },
    ]),
  ).toBeUndefined();
});
it("private report delivery retries without AI and active scheduled check can deliver promised result", async () => {
  const r: any = await db.put("monitor_runs", {
    idempotency_key: "scheduled",
    trigger_type: "scheduled",
  });
  await manualReview(db, "prepare", randomUUID(), "11");
  const report = makeReport([], [], [], [], null, cfg);
  await db.rpc("radar_save_report", { p_run: r.id, p_report: report });
  const worker = new Worker(db, cfg, tg);
  const send = vi.spyOn(tg, "send").mockRejectedValueOnce(new Error("offline"));
  await worker.deliverManualResults();
  expect(
    (await db.all("monitor_runs", { id: r.id }))[0].state.manualDelivered,
  ).not.toBe(true);
  send.mockRestore();
  await worker.deliverManualResults();
  expect(
    (await db.all("monitor_runs", { id: r.id }))[0].state.manualDelivered,
  ).toBe(true);
  expect(sent[0].text).toContain("Текущая проверка завершена");
  expect(manualReportPages(report).every((p) => p.length <= 3800)).toBe(true);
});
it("new tables and RPC deny anonymous access", async () => {
  const rows = await db.pg.query(
    "select has_table_privilege('anon','public.manual_review_requests','SELECT') as readable,has_function_privilege('anon','public.radar_manual_review(text,uuid,text)','EXECUTE') as callable",
  );
  expect(rows.rows[0]).toEqual({ readable: false, callable: false });
});
