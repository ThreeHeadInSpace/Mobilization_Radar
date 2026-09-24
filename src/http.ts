import { timingSafeEqual, randomUUID } from "node:crypto";
import { config, required } from "./config/index.js";
import { SupabaseDB } from "./database/index.js";
import { Telegram, handleUpdate } from "./telegram/index.js";
import { Worker } from "./jobs/worker.js";
import { runSmoke } from "./smoke.js";
import { setupTelegram } from "./setup/telegram.js";
import { manualReview, uuidPattern } from "./jobs/manual-review.js";
import { adminText } from "./telegram/admin-text.js";
export function secureEqual(actual: string | undefined, expected: string) {
  return (
    expected.length >= 24 &&
    typeof actual === "string" &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}
export async function route(
  path: string,
  method: string,
  headers: Record<string, string | undefined>,
  body: any,
): Promise<{ status: number; body: unknown }> {
  try {
    const c = config();
    if (path === "/api/health") {
      let database = false;
      let configured = false;
      try {
        required(c, [
          "SUPABASE_URL",
          "SUPABASE_SECRET_KEY",
          "XAI_API_KEY",
          "TELEGRAM_BOT_TOKEN",
          "TELEGRAM_ADMIN_CHAT_ID",
          "TELEGRAM_CHANNEL_ID",
          "CRON_SECRET",
          "TELEGRAM_WEBHOOK_SECRET",
        ]);
        configured = true;
        await new SupabaseDB(c).all("config", {}, undefined, 1);
        database = true;
      } catch {}
      return {
        status: database && configured ? 200 : 503,
        body: { alive: true, database, configured },
      };
    }
    if (method !== "POST")
      return { status: 405, body: { error: "method_not_allowed" } };
    if (path === "/api/manual-review") {
      if (
        c.CRON_SECRET.length < 24 ||
        !secureEqual(headers.authorization, `Bearer ${c.CRON_SECRET}`)
      )
        return { status: 401, body: { error: "unauthorized" } };
      const token = headers["idempotency-key"] ?? randomUUID();
      if (!uuidPattern.test(token))
        return { status: 400, body: { error: "invalid_idempotency_key" } };
      required(c, [
        "SUPABASE_URL",
        "SUPABASE_SECRET_KEY",
        "TELEGRAM_ADMIN_CHAT_ID",
      ]);
      const result = await manualReview(
        new SupabaseDB(c),
        "direct",
        token,
        "api",
      );
      if (result.fresh)
        await new Telegram(c)
          .send(c.TELEGRAM_ADMIN_CHAT_ID, adminText.started)
          .catch(() => {});
      return {
        status: 200,
        body: {
          ok: true,
          status: result.status,
          ...(result.runId ? { runId: result.runId } : {}),
        },
      };
    }
    if (path === "/api/setup/telegram") {
      if (
        c.CRON_SECRET.length < 24 ||
        !secureEqual(headers.authorization, `Bearer ${c.CRON_SECRET}`)
      )
        return { status: 401, body: { error: "unauthorized" } };
      return await setupTelegram(c);
    }
    if (path === "/api/smoke") {
      if (
        c.CRON_SECRET.length < 24 ||
        !secureEqual(headers.authorization, `Bearer ${c.CRON_SECRET}`)
      )
        return { status: 401, body: { error: "unauthorized" } };
      return await runSmoke(c);
    }
    if (path === "/api/jobs") {
      if (
        !secureEqual(headers.authorization, `Bearer ${c.CRON_SECRET}`) ||
        c.CRON_SECRET.length < 24
      )
        return { status: 401, body: { error: "unauthorized" } };
      required(c, ["SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
      const db = new SupabaseDB(c);
      return {
        status: 200,
        body: await new Worker(db, c, new Telegram(c)).tick(),
      };
    }
    if (path === "/api/telegram") {
      if (
        !secureEqual(
          headers["x-telegram-bot-api-secret-token"],
          c.TELEGRAM_WEBHOOK_SECRET,
        )
      )
        return { status: 401, body: { error: "unauthorized" } };
      await handleUpdate(new SupabaseDB(c), new Telegram(c), c, body);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: "not_found" } };
  } catch {
    return { status: 503, body: { error: "service_unavailable" } };
  }
}
