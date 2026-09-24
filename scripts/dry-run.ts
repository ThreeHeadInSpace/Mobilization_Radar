import { TestDB } from "../tests/db.js";
import { cfg, source, article, finding } from "../tests/fixtures.js";
import { Worker } from "../src/jobs/worker.js";
import { Telegram, handleUpdate, publish } from "../src/telegram/index.js";
import type { AIProvider } from "../src/providers/ai-provider.js";
import { randomUUID } from "node:crypto";
const db = await TestDB.create();
const a = article();
let sent = 0;
const messages: string[] = [];
const tg = new Telegram(cfg, async (url, init) => {
  const method = String(url).split("/").at(-1);
  if (method === "sendMessage") {
    sent++;
    messages.push(JSON.parse(String(init?.body)).text);
  }
  return new Response(
    JSON.stringify({
      ok: true,
      result:
        method === "getMe"
          ? { id: 1, username: "dry_bot" }
          : method === "getChatMember"
            ? { status: "administrator", can_post_messages: true }
            : method === "sendMessage"
              ? { message_id: sent }
              : { type: "channel" },
    }),
  );
});
const ai: AIProvider = {
  triage: async () => ({
    relevant: true,
    eventType: "unusual_summons",
    region: source.region,
    sourceRole: "primary",
    primarySourceLikelihood: "high",
    novelty: "new",
    verificationHint: "fixture",
    needsDeepAnalysis: true,
  }),
  analyze: async () => {
    const { chains, evidenceTypes, change, freshOfficial, ...event } =
      finding(a);
    return { events: [event], limitations: [] };
  },
};
try {
  await db.put("sources", source);
  const worker = new Worker(
    db,
    cfg,
    tg,
    () => ai,
    async () => ({
      sourceId: source.id,
      status: "ok",
      httpCode: 200,
      errorCode: null,
      duration: 1,
      itemsDiscovered: 1,
      retryCount: 0,
      articles: [a],
    }),
  );
  let run = await worker.start(`dry:${randomUUID()}`, "dry");
  for (let i = 0; i < 15 && run.status === "running"; i++) {
    await worker.step(run, new Date());
    run = (await db.all("monitor_runs", { id: run.id }))[0];
  }
  if (run.status !== "completed") throw new Error("dry_pipeline_failed");
  const report = (await db.all("run_reports", { run_id: run.id }))[0].data;
  const sid = await db.rpc("radar_stage", { p_run: run.id, p_report: report });
  await tg.notifyReview(report);
  await handleUpdate(db, tg, cfg, {
    callback_query: {
      id: "dry-approval",
      data: `approve:${report.publicId}`,
      from: { id: 11 },
      message: { chat: { id: 11, type: "private" } },
    },
  });
  const summary = (await db.all("summaries", { id: sid }))[0];
  await publish(db, tg, cfg, summary);
  await handleUpdate(db, tg, cfg, {
    message: {
      chat: { id: 55, type: "private" },
      text: `/start sources_${report.publicId}`,
    },
  });
  await handleUpdate(db, tg, cfg, {
    message: {
      chat: { id: 55, type: "private" },
      text: "/start methodology_v1",
    },
  });
  console.log(
    JSON.stringify(
      {
        mode: "offline; no real Telegram/AI calls",
        run: run.status,
        level: report.federalSignal.level,
        review: report.reviewState,
        snapshotRows: (await db.all("summary_sources")).length,
        publication: (await db.all("publication_queue"))[0].status,
        sourceResponse: messages.some((m) =>
          m.includes("📚 Источники выпуска"),
        ),
        methodologyResponse: messages.some((m) =>
          m.includes("Методология РАДАР М"),
        ),
        text: report.telegramText,
      },
      null,
      2,
    ),
  );
} finally {
  await db.pg.close();
}
