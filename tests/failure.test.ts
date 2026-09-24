import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { TestDB } from "./db.js";
import { cfg, source, article, finding } from "./fixtures.js";
import { makeReport } from "../src/reports/index.js";
import { Telegram, publish, handleUpdate } from "../src/telegram/index.js";
import { verifyFindings } from "../src/intelligence/index.js";
it("uncertain send cannot publish twice; channel receipt reconciles", async () => {
  const db = await TestDB.create();
  try {
    await db.put("sources", source);
    const a = article();
    await db.put("articles", a);
    const run = randomUUID();
    await db.put("monitor_runs", {
      id: run,
      idempotency_key: run,
      trigger_type: "test",
    });
    const report = makeReport([finding(a)], [a], [source], [], null, cfg);
    const sid = await db.rpc("radar_stage", { p_run: run, p_report: report });
    await db.rpc("radar_admin", {
      p_public: report.publicId,
      p_action: "approve",
      p_actor: "11",
      p_key: "once",
    });
    let calls = 0;
    const tg = new Telegram(cfg, async (url) => {
      const method = String(url).split("/").at(-1);
      if (method === "sendMessage") {
        calls++;
        throw new Error("timeout_after_send");
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result:
            method === "getMe"
              ? { id: 1, username: "test_bot" }
              : method === "getChatMember"
                ? { status: "administrator" }
                : { type: "channel" },
        }),
      );
    });
    const summary = (await db.all("summaries", { id: sid }))[0];
    expect(await publish(db, tg, cfg, summary)).toBe("unknown");
    const after = calls;
    await publish(db, tg, cfg, summary);
    expect(calls).toBe(after);
    await handleUpdate(db, tg, cfg, {
      channel_post: {
        chat: { id: cfg.TELEGRAM_CHANNEL_ID },
        message_id: 123,
        text: report.telegramText,
      },
    });
    expect(
      (await db.all("publication_queue", { summary_id: sid }))[0].status,
    ).toBe("published");
    await expect(
      db.patch("summaries", { id: sid }, { superseded: true }),
    ).rejects.toThrow();
  } finally {
    await db.pg.close();
  }
}, 30000);
it("a cited primary source plus its republication counts once", () => {
  const a = article(),
    b = {
      ...article(),
      id: randomUUID(),
      source_id: "repost",
      canonical_url: "https://repost.example/news",
      raw_metadata: { links: [a.canonical_url] },
    };
  const f = finding(a);
  const evidence = [
    ...f.evidence,
    {
      ...f.evidence[0],
      articleId: b.id,
      originalUrl: a.canonical_url,
      independent: false,
    },
  ];
  const { chains, evidenceTypes, change, freshOfficial, ...raw } = f;
  const out = verifyFindings(
    { events: [{ ...raw, evidence }], limitations: [] },
    [a, b],
    [
      source,
      {
        ...source,
        id: "repost",
        base_url: "https://repost.example",
        type: "MAJOR_MEDIA",
      },
    ],
    [],
  );
  expect(out[0].chains).toHaveLength(1);
});
it("a new confirmation and debunk are distinguished from old story", () => {
  const a = article(),
    f = finding(a);
  const { chains, evidenceTypes, change, freshOfficial, ...raw } = f;
  const old = { ...f, verificationStatus: "UNVERIFIED" as const };
  expect(
    verifyFindings({ events: [raw], limitations: [] }, [a], [source], [old])[0]
      .change,
  ).toBe("status_change");
  expect(
    verifyFindings({ events: [raw], limitations: [] }, [a], [source], [f])[0]
      .change,
  ).toBe("unchanged");
});
