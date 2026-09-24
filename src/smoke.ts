import type { Config } from "./config/index.js";
import { SupabaseDB } from "./database/index.js";
import { Telegram } from "./telegram/index.js";
import { XAIProvider } from "./providers/xai-provider.js";

type Check = { status: "ok" | "failed" | "skipped"; code?: string };
const failed = (code: string): Check => ({ status: "failed", code });
// Only fixed codes cross the HTTP boundary; never return upstream bodies or exceptions.
function telegramError(e: unknown): Check {
  const message = e instanceof Error ? e.message : "";
  return failed(
    /^telegram_http_[45]\d{2}$/.test(message)
      ? message
      : message === "telegram_rejected"
        ? message
        : "telegram_unavailable",
  );
}

export async function runSmoke(c: Config, request: typeof fetch = fetch) {
  // Each request is bounded, including DB calls. Redirects cannot forward credentials.
  const boundedFetch: typeof fetch = (input, init) =>
    request(input, {
      ...init,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  let db: SupabaseDB | undefined;
  if (c.SUPABASE_URL && c.SUPABASE_SECRET_KEY) {
    try {
      db = new SupabaseDB(c, boundedFetch);
    } catch {
      /* Report configuration failure below. */
    }
  }
  const checks: Record<string, Check> = {};
  const tg = new Telegram(c, boundedFetch);
  let botId: number | undefined;
  let channelValid = false;
  async function telegramCheck(
    name: string,
    configured: boolean,
    method: string,
    body: Record<string, unknown>,
    validate: (result: any) => boolean,
  ) {
    if (!configured) {
      checks[name] = failed("configuration_missing");
      return;
    }
    try {
      const result = await tg.call(method, body);
      checks[name] = validate(result)
        ? { status: "ok" }
        : failed("unexpected_telegram_result");
    } catch (e) {
      checks[name] = telegramError(e);
    }
  }
  await Promise.allSettled([
    (async () => {
      if (!db) {
        checks.supabase = failed("configuration_missing");
        return;
      }
      try {
        await db.all("config", {}, undefined, 1);
        checks.supabase = { status: "ok" };
      } catch {
        checks.supabase = failed("database_unavailable");
      }
    })(),
    (async () => {
      await Promise.allSettled([
        telegramCheck(
          "telegramGetMe",
          !!c.TELEGRAM_BOT_TOKEN,
          "getMe",
          {},
          (r) => {
            if (!r?.is_bot || !Number.isSafeInteger(r.id)) return false;
            botId = r.id;
            return true;
          },
        ),
        telegramCheck(
          "telegramAdminChat",
          !!c.TELEGRAM_BOT_TOKEN && !!c.TELEGRAM_ADMIN_CHAT_ID,
          "getChat",
          { chat_id: c.TELEGRAM_ADMIN_CHAT_ID },
          (r) => ["private", "group", "supergroup"].includes(r?.type),
        ),
        telegramCheck(
          "telegramChannel",
          !!c.TELEGRAM_BOT_TOKEN && !!c.TELEGRAM_CHANNEL_ID,
          "getChat",
          { chat_id: c.TELEGRAM_CHANNEL_ID },
          (r) => {
            channelValid = r?.type === "channel";
            return channelValid;
          },
        ),
      ]);
      if (botId === undefined || !channelValid) {
        checks.telegramPermissions = {
          status: "skipped",
          code: "telegram_prerequisite_failed",
        };
        return;
      }
      await telegramCheck(
        "telegramPermissions",
        true,
        "getChatMember",
        { chat_id: c.TELEGRAM_CHANNEL_ID, user_id: botId },
        (r) =>
          r?.user?.id === botId &&
          (r.status === "creator" ||
            (r.status === "administrator" && r.can_post_messages === true)),
      );
    })(),
    (async () => {
      if (!c.XAI_API_KEY || !c.XAI_BASE_URL || !c.XAI_TRIAGE_MODEL) {
        checks.xai = failed("configuration_missing");
        checks.aiUsage = { status: "skipped", code: "no_ai_request" };
        return;
      }
      let errorCode = "analysis_failed";
      const ai = new XAIProvider(
        c,
        async (usage) => {
          if (usage.error_code && /^http_[45]\d{2}$/.test(usage.error_code))
            errorCode = usage.error_code;
          if (!db) {
            checks.aiUsage = failed("configuration_missing");
            return;
          }
          try {
            await db.put("ai_usage", {
              ...usage,
              operation: "smoke_triage",
              run_id: null,
            });
            checks.aiUsage = { status: "ok" };
          } catch {
            checks.aiUsage = failed("usage_logging_failed");
          }
        },
        boundedFetch,
        { maxAttempts: 1, timeoutMs: 15000, maxOutputTokens: 512 },
      );
      try {
        await ai.triage({
          id: "production-smoke",
          source_id: "synthetic-smoke",
          canonical_url: "https://example.org/smoke",
          original_url: "https://example.org/smoke",
          title: "Служебная проверка",
          published_at: null,
          discovered_at: new Date().toISOString(),
          text: "Синтетический тест: обычное плановое уточнение воинского учёта. Новых событий нет.",
          content_hash: "synthetic-smoke",
          region: null,
          raw_metadata: { links: [] },
        });
        checks.xai = { status: "ok" };
      } catch {
        checks.xai = failed(errorCode);
      }
    })(),
  ]);
  const names = [
    "supabase",
    "telegramGetMe",
    "telegramAdminChat",
    "telegramChannel",
    "telegramPermissions",
    "xai",
    "aiUsage",
  ];
  for (const name of names) checks[name] ??= failed("check_failed");
  const ok = names.every((name) => checks[name].status === "ok");
  return { status: ok ? 200 : 503, body: { ok, checks } };
}
