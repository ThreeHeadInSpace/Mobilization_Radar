import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { activate } from "../scripts/activation.js";
import { configureScheduler } from "../scripts/scheduler.js";
import { envSchema } from "../src/config/index.js";
import { route } from "../src/http.js";
import handler from "../api/setup/telegram.js";
const c = envSchema.parse({
  APP_URL: "https://radar.example/",
  CRON_SECRET: "activation-test-secret-123456789",
  TELEGRAM_WEBHOOK_SECRET: "webhook-test-secret-123456789",
  TELEGRAM_BOT_TOKEN: "test-bot",
  TELEGRAM_ADMIN_CHAT_ID: "admin-test",
  TELEGRAM_CHANNEL_ID: "channel-test",
});
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  for (const [key, value] of Object.entries(c)) vi.stubEnv(key, String(value));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function telegramMock(
  options: { smokeFail?: boolean; webhookFail?: boolean } = {},
) {
  const calls: { method: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      expect(String(url)).toMatch(/^https:\/\/api.telegram.org\//);
      expect(init.redirect).toBe("error");
      const method = String(url).split("/").at(-1)!,
        body = JSON.parse(init.body);
      calls.push({ method, body });
      if (options.smokeFail) throw new Error(c.TELEGRAM_BOT_TOKEN);
      if (method === "getMe")
        return json({
          ok: true,
          result: { id: 1, is_bot: true, username: "private-name" },
        });
      if (method === "getChat")
        return json({
          ok: true,
          result: {
            type:
              body.chat_id === c.TELEGRAM_ADMIN_CHAT_ID ? "private" : "channel",
          },
        });
      if (method === "getChatMember")
        return json({
          ok: true,
          result: { status: "administrator", can_post_messages: true },
        });
      if (method === "setWebhook")
        return json({ ok: true, result: !options.webhookFail });
      throw new Error("Forbidden operation");
    }),
  );
  return calls;
}
const call = () =>
  route(
    "/api/setup/telegram",
    "POST",
    { authorization: `Bearer ${c.CRON_SECRET}` },
    { url: "https://attacker.example", secret_token: "attacker" },
  );
it("production setup authenticates and rejects GET before network calls", async () => {
  const calls = telegramMock();
  expect((await route("/api/setup/telegram", "POST", {}, {})).status).toBe(401);
  expect((await route("/api/setup/telegram", "GET", {}, {})).status).toBe(405);
  vi.stubEnv("CRON_SECRET", "");
  expect((await call()).status).toBe(401);
  expect(calls).toHaveLength(0);
});
it("production sets only configured webhook after smoke, with no messages or other services", async () => {
  const calls = telegramMock();
  const result = await call();
  expect(result).toEqual({
    status: 200,
    body: { ok: true, telegram: "ok", webhook: "registered" },
  });
  expect(calls.map((x) => x.method)).toEqual([
    "getMe",
    "getChat",
    "getChat",
    "getChatMember",
    "setWebhook",
  ]);
  expect(calls.at(-1)?.body).toEqual({
    url: "https://radar.example/api/telegram",
    secret_token: c.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "channel_post"],
    drop_pending_updates: false,
  });
  await call();
  expect(
    calls.filter((x) => x.method === "setWebhook").map((x) => x.body),
  ).toEqual([calls[4].body, calls[4].body]);
  for (const value of [
    c.TELEGRAM_BOT_TOKEN,
    c.TELEGRAM_WEBHOOK_SECRET,
    c.CRON_SECRET,
    "private-name",
  ])
    expect(JSON.stringify(result)).not.toContain(value);
});
it.each([
  "http://radar.example",
  "https://user:pass@radar.example",
  "https://radar.example/?token=bad",
  "https://radar.example/prefix",
])("rejects unsafe APP_URL before Telegram: %s", async (url) => {
  const calls = telegramMock();
  vi.stubEnv("APP_URL", url);
  expect((await call()).status).toBe(503);
  expect(calls).toHaveLength(0);
});
it("does not register webhook when smoke fails and does not leak error", async () => {
  const calls = telegramMock({ smokeFail: true });
  const r = await call();
  expect((r.body as any).error).toBe("telegram_smoke_failed");
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(r)).not.toContain(c.TELEGRAM_BOT_TOKEN);
});
it("treats unsuccessful setWebhook as a failure", async () => {
  telegramMock({ webhookFail: true });
  expect((await call()).body).toEqual({
    ok: false,
    error: "telegram_webhook_failed",
  });
});
it("serverless setup responses are not cached", async () => {
  const calls = telegramMock();
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  await handler({ method: "POST", headers: {} }, res);
  expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  expect(calls).toHaveLength(0);
});
it("local activation contacts only Vercel then configures scheduler, even without local Telegram credentials", async () => {
  const order: string[] = [];
  const scheduler = vi.fn(async () => {
    order.push("scheduler");
  });
  const request: typeof fetch = async (url, init) => {
    order.push(String(url));
    expect(init?.redirect).toBe("error");
    if (String(url).endsWith("/api/health"))
      return json({ alive: true, database: true, configured: true });
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${c.CRON_SECRET}` });
    return json({ ok: true, telegram: "ok", webhook: "registered" });
  };
  await activate(
    { ...c, TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "" },
    scheduler,
    request,
  );
  expect(order).toEqual([
    "https://radar.example/api/health",
    "https://radar.example/api/setup/telegram",
    "scheduler",
  ]);
  expect(scheduler).toHaveBeenCalledWith(
    "https://radar.example",
    c.CRON_SECRET,
  );
});
it.each(["health", "telegram", "malformed"])(
  "does not configure Vault or Cron after %s failure",
  async (failure) => {
    const scheduler = vi.fn();
    const urls: string[] = [];
    const request: typeof fetch = async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/health"))
        return json(
          { alive: true, database: true, configured: true },
          failure === "health" ? 503 : 200,
        );
      if (failure === "malformed")
        return new Response("private upstream detail");
      return json({ error: c.CRON_SECRET }, 503);
    };
    await expect(activate(c, scheduler, request)).rejects.toThrow(
      failure === "health"
        ? "production_health_failed"
        : "production_telegram_setup_failed",
    );
    expect(scheduler).not.toHaveBeenCalled();
    if (failure === "health") expect(urls).toHaveLength(1);
  },
);
it("local scheduler failures are sanitized", async () => {
  const request: typeof fetch = async (url) =>
    String(url).endsWith("/health")
      ? json({ alive: true, database: true, configured: true })
      : json({ ok: true, telegram: "ok", webhook: "registered" });
  await expect(
    activate(
      c,
      async () => {
        throw new Error(c.CRON_SECRET);
      },
      request,
    ),
  ).rejects.toThrow("scheduler_setup_failed");
});
it("scheduler transaction preserves secret and repeats one named job without duplicates", async () => {
  const pg = new PGlite();
  try {
    // PostgreSQL fixtures for the external extensions; no production Vault/Cron mutations.
    await pg.exec(`create schema vault; create schema cron;
      create table vault.secrets(id uuid primary key default gen_random_uuid(),name text unique,secret text);
      create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
      create function vault.create_secret(value text,label text) returns uuid language sql as $$insert into vault.secrets(name,secret) values(label,value) returning id$$;
      create function vault.update_secret(key uuid,value text,label text) returns void language sql as $$update vault.secrets set secret=value,name=label where id=key$$;
      create table cron.job(jobid bigint generated always as identity,jobname text unique,schedule text,command text);
      create function cron.schedule(label text,timing text,cmd text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values(label,timing,cmd) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid$$;`);
    const sql = {
      begin: async (fn: any) =>
        pg.transaction(async (tx) =>
          fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const query = strings.reduce(
              (s, part, i) => s + (i ? `$${i}` : "") + part,
              "",
            );
            return (await tx.query(query, values)).rows;
          }),
        ),
    } as unknown as Sql;
    await configureScheduler(sql, "https://radar.example", c.CRON_SECRET);
    const before = (await pg.query("select jobid from cron.job")).rows;
    await configureScheduler(sql, "https://radar.example", c.CRON_SECRET);
    expect((await pg.query("select jobid from cron.job")).rows).toEqual(before);
    expect((await pg.query("select * from vault.secrets")).rows).toHaveLength(
      2,
    );
    await expect(
      configureScheduler(sql, "https://changed.example", "different-secret"),
    ).rejects.toThrow("vault_secret_mismatch");
    expect(
      (
        await pg.query(
          "select secret from vault.secrets where name='radar_app_url'",
        )
      ).rows,
    ).toEqual([{ secret: "https://radar.example" }]);
    expect((await pg.query("select jobid from cron.job")).rows).toEqual(before);
  } finally {
    await pg.close();
  }
}, 30000);
