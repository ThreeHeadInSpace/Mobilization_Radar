import { config } from "../src/config/index.js";
import { SupabaseDB } from "../src/database/index.js";
import { Telegram } from "../src/telegram/index.js";
import { Worker } from "../src/jobs/worker.js";
import { randomUUID } from "node:crypto";
if (!process.argv.includes("--review-only"))
  throw new Error(
    "Use --review-only; this command never publishes to the channel.",
  );
const c = {
  ...config(),
  REQUIRE_REVIEW_ALL: true,
  AUTO_PUBLISH_SAFE_REPORTS: false,
};
const db = new SupabaseDB(c),
  tg = new Telegram(c),
  worker = new Worker(db, c, tg);
const key = `manual-review:${randomUUID()}`;
let run: any;
for (let i = 0; i < 1000; i++) {
  const owner = randomUUID();
  if (
    !(await db.rpc("radar_lock", {
      p_name: "worker",
      p_owner: owner,
      p_seconds: 240,
    }))
  )
    throw new Error("worker_busy");
  try {
    run = run ?? (await worker.start(key, "manual-review"));
    await worker.step(run, new Date());
    run = (await db.all("monitor_runs", { id: run.id }))[0];
  } finally {
    await db.rpc("radar_unlock", { p_name: "worker", p_owner: owner });
  }
  if (run.status !== "running") break;
}
if (!["completed", "degraded"].includes(run.status)) {
  console.log("Monitoring failed; no publication staged.");
  process.exitCode = 1;
} else {
  await worker.stageDaily(new Date());
  const summary = (
    await db.all("summaries", { run_id: run.id, superseded: false })
  )[0];
  if (summary) await tg.notifyReview(summary.data);
  console.log(
    JSON.stringify({
      status: run.status,
      reportStaged: !!summary,
      channelPublication: false,
    }),
  );
}
