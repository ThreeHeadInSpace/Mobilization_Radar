import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { TestDB } from "./db.js";
import { cfg, source, article, finding } from "./fixtures.js";
import { makeReport } from "../src/reports/index.js";
import { Telegram, publish, handleUpdate } from "../src/telegram/index.js";
let db: TestDB;
let run: string;
let report: any;
let sid: string;
beforeAll(async () => {
  db = await TestDB.create();
  await db.put("sources", source);
  const a = article();
  await db.put("articles", a);
  run = randomUUID();
  await db.put("monitor_runs", {
    id: run,
    idempotency_key: "test-run",
    trigger_type: "test",
  });
  report = makeReport(
    [finding(a)],
    [a],
    [source],
    [
      {
        sourceId: source.id,
        status: "ok",
        httpCode: 200,
        errorCode: null,
        duration: 1,
        itemsDiscovered: 1,
        retryCount: 0,
        articles: [],
      },
    ],
    null,
    cfg,
  );
  await db.rpc("radar_save_report", { p_run: run, p_report: report });
  sid = await db.rpc("radar_stage", { p_run: run, p_report: report });
}, 30000);
afterAll(async () => {
  await db.pg.close();
});
it("persists immutable source snapshot and reasons", async () => {
  expect(
    (await db.all("summary_sources", { summary_id: sid }))[0].data.url,
  ).toContain("example.org");
  expect(
    (await db.all("signal_snapshots", { run_id: run }))[0].data.reasons.length,
  ).toBeGreaterThan(0);
  await expect(
    db.patch(
      "summary_sources",
      { summary_id: sid },
      { data: { url: "changed" } },
    ),
  ).rejects.toThrow();
});
it("one report per date and exclusive lease", async () => {
  expect(
    await db.rpc("radar_stage", { p_run: run, p_report: report }),
  ).toBeNull();
  const args = { p_name: "test", p_owner: randomUUID(), p_seconds: 60 };
  expect(await db.rpc("radar_lock", args)).toBe(true);
  expect(await db.rpc("radar_lock", { ...args, p_owner: randomUUID() })).toBe(
    false,
  );
});
it("rejects unauthorized admin and applies approval once", async () => {
  const tg = new Telegram(
    cfg,
    async () => new Response(JSON.stringify({ ok: true, result: {} })),
  );
  await handleUpdate(db, tg, cfg, {
    callback_query: {
      id: "bad",
      data: `approve:${report.publicId}`,
      from: { id: 99 },
      message: { chat: { id: 11, type: "private" } },
    },
  });
  expect(
    (await db.all("publication_queue", { summary_id: sid }))[0].status,
  ).toBe("review");
  const args = {
    p_public: report.publicId,
    p_action: "approve",
    p_actor: "11",
    p_key: "approval-1",
  };
  expect(await db.rpc("radar_admin", args)).toBe("ready");
  expect(await db.rpc("radar_admin", args)).toBe("duplicate");
});
it("publishes once even with repeated requests and keeps original snapshot", async () => {
  let sends = 0;
  const tg = new Telegram(cfg, async (url) => {
    const method = String(url).split("/").at(-1);
    if (method === "sendMessage") sends++;
    return new Response(
      JSON.stringify({
        ok: true,
        result:
          method === "getMe"
            ? { id: 1, username: "test_bot" }
            : method === "getChatMember"
              ? { status: "administrator", can_post_messages: true }
              : method === "sendMessage"
                ? { message_id: 42 }
                : { type: "channel" },
      }),
    );
  });
  const summary = (await db.all("summaries", { id: sid }))[0];
  expect(await publish(db, tg, cfg, summary)).toBe("published");
  expect(await publish(db, tg, cfg, summary)).toBe("already_claimed");
  expect(sends).toBe(1);
  expect((await db.all("summaries", { id: sid }))[0].published_at).toBeTruthy();
});
it("anonymous role cannot read or execute publishing functions", async () => {
  await db.pg.exec("set role anon");
  try {
    await expect(db.pg.query("select * from summaries")).rejects.toThrow();
    await expect(
      db.pg.query("select radar_claim_publication($1,$2)", [sid, randomUUID()]),
    ).rejects.toThrow();
  } finally {
    await db.pg.exec("reset role");
  }
});
