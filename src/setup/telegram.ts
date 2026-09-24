import type { Config } from "../config/index.js";
import { Telegram } from "../telegram/index.js";
import { appOrigin } from "./app-url.js";

export async function setupTelegram(c: Config, request: typeof fetch = fetch) {
  let origin: string;
  try {
    origin = appOrigin(c.APP_URL);
    if (
      !c.TELEGRAM_BOT_TOKEN ||
      !c.TELEGRAM_ADMIN_CHAT_ID ||
      !c.TELEGRAM_CHANNEL_ID ||
      !/^[A-Za-z0-9_-]{24,256}$/.test(c.TELEGRAM_WEBHOOK_SECRET)
    )
      throw new Error();
  } catch {
    return {
      status: 503,
      body: { ok: false, error: "setup_configuration_invalid" },
    };
  }
  const tg = new Telegram(c, (input, init) =>
    request(input, { ...init, redirect: "error" }),
  );
  try {
    const smoke = await tg.smoke();
    if (
      smoke.channelType !== "channel" ||
      !["private", "group", "supergroup"].includes(smoke.adminType)
    )
      throw new Error();
  } catch {
    return { status: 503, body: { ok: false, error: "telegram_smoke_failed" } };
  }
  try {
    const registered = await tg.call("setWebhook", {
      url: `${origin}/api/telegram`,
      secret_token: c.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query", "channel_post"],
      drop_pending_updates: false,
    });
    if (registered !== true) throw new Error();
    return {
      status: 200,
      body: { ok: true, telegram: "ok", webhook: "registered" },
    };
  } catch {
    return {
      status: 503,
      body: { ok: false, error: "telegram_webhook_failed" },
    };
  }
}
