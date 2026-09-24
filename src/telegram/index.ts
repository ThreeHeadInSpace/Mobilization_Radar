import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import type { DB } from "../database/index.js";
import type { Report } from "../domain.js";
import { deepLink, sourcePages, methodology } from "../reports/index.js";
export class Telegram {
  constructor(
    private c: Config,
    private request: typeof fetch = fetch,
  ) {}
  async call(method: string, body: Record<string, unknown> = {}) {
    const r = await this.request(
      `https://api.telegram.org/bot${this.c.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) throw new Error(`telegram_http_${r.status}`);
    const data: any = await r.json();
    if (!data.ok) throw new Error("telegram_rejected");
    return data.result;
  }
  async smoke() {
    const me = await this.call("getMe");
    const admin = await this.call("getChat", {
      chat_id: this.c.TELEGRAM_ADMIN_CHAT_ID,
    });
    const channel = await this.call("getChat", {
      chat_id: this.c.TELEGRAM_CHANNEL_ID,
    });
    const member = await this.call("getChatMember", {
      chat_id: this.c.TELEGRAM_CHANNEL_ID,
      user_id: me.id,
    });
    if (
      !["administrator", "creator"].includes(member.status) ||
      member.can_post_messages === false
    )
      throw new Error("telegram_no_publish_rights");
    return {
      username: me.username,
      adminType: admin.type,
      channelType: channel.type,
    };
  }
  send(chat: string, text: string, reply_markup?: unknown) {
    return this.call("sendMessage", {
      chat_id: chat,
      text,
      link_preview_options: { is_disabled: true },
      ...(reply_markup ? { reply_markup } : {}),
    });
  }
  async notifyReview(report: Report) {
    const chains = new Set(report.events.flatMap((e) => e.chains)).size;
    return this.send(
      this.c.TELEGRAM_ADMIN_CHAT_ID,
      `РАДАР М · проверка выпуска ${report.reportDate}\nИндекс: ${report.federalSignal.level ?? "нет данных"}; предыдущий: ${report.federalSignal.previousLevel ?? "нет данных"}\n${report.reviewReasons.join("\n")}\nИзменения:\n${report.whatChanged.slice(0, 4).join("\n") || "Новых находок нет."}\nРегионы: ${Object.keys(report.regionalSignals).join(", ")}\nНезависимых цепочек: ${chains}\n${report.sources
        .slice(0, 3)
        .map((s) => s.url)
        .join("\n")}`.slice(0, 3800),
      {
        inline_keyboard: [
          [
            {
              text: "📚 Источники",
              callback_data: `sources:${report.publicId}`,
            },
          ],
          [
            {
              text: "✅ Одобрить публикацию",
              callback_data: `approve:${report.publicId}`,
            },
            {
              text: "❌ Отклонить",
              callback_data: `reject:${report.publicId}`,
            },
          ],
          [
            {
              text: "🔄 Повторить анализ",
              callback_data: `reanalyze:${report.publicId}`,
            },
          ],
        ],
      },
    );
  }
}
export async function publish(db: DB, tg: Telegram, c: Config, summary: any) {
  const report: Report = summary.data;
  // Preflight happens before the irreversible transition. A send is never retried automatically.
  const { username } = await tg.smoke();
  const attempt = randomUUID();
  if (
    !(await db.rpc("radar_claim_publication", {
      p_summary: summary.id,
      p_attempt: attempt,
    }))
  )
    return "already_claimed";
  try {
    const result = await tg.send(c.TELEGRAM_CHANNEL_ID, report.telegramText, {
      inline_keyboard: [
        [
          {
            text: "📚 Источники",
            url: deepLink(username, `sources_${report.publicId}`),
          },
          {
            text: "ℹ️ Как считаем индекс",
            url: deepLink(username, "methodology_v1"),
          },
        ],
      ],
    });
    await db.rpc("radar_finish_publication", {
      p_summary: summary.id,
      p_attempt: attempt,
      p_message: result.message_id,
      p_channel: c.TELEGRAM_CHANNEL_ID,
    });
    return "published";
  } catch {
    await db.patch(
      "publication_queue",
      { summary_id: summary.id, attempt_id: attempt, status: "sending" },
      { status: "unknown" },
    );
    await tg
      .send(
        c.TELEGRAM_ADMIN_CHAT_ID,
        `Неопределённый результат отправки выпуска ${report.publicId}. Автоповтор заблокирован. Проверьте канал и выполните ручную сверку очереди.`,
      )
      .catch(() => {});
    return "unknown";
  }
}
export async function handleUpdate(
  db: DB,
  tg: Telegram,
  c: Config,
  update: any,
) {
  const channelPost = update.channel_post;
  if (channelPost && String(channelPost.chat?.id) === c.TELEGRAM_CHANNEL_ID) {
    for (const status of ["sending", "unknown"])
      for (const q of await db.all("publication_queue", { status })) {
        const s = (await db.all("summaries", { id: q.summary_id }))[0];
        if (channelPost.text === s?.data.telegramText && q.attempt_id) {
          await db.rpc("radar_finish_publication", {
            p_summary: s.id,
            p_attempt: q.attempt_id,
            p_message: channelPost.message_id,
            p_channel: c.TELEGRAM_CHANNEL_ID,
          });
          return;
        }
      }
    return;
  }
  const callback = update.callback_query;
  if (callback) {
    const chat = callback.message?.chat;
    const authorized =
      String(chat?.id) === c.TELEGRAM_ADMIN_CHAT_ID &&
      (chat?.type === "private"
        ? String(callback.from?.id) === c.TELEGRAM_ADMIN_CHAT_ID
        : !!c.TELEGRAM_OWNER_ID &&
          String(callback.from?.id) === c.TELEGRAM_OWNER_ID);
    if (!authorized) {
      await tg.call("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Нет доступа",
      });
      return;
    }
    const match = /^(sources|approve|reject|reanalyze):([a-f0-9]{24})$/.exec(
      callback.data ?? "",
    );
    if (!match) return;
    const [, action, key] = match;
    const summary = (await db.all("summaries", { public_id: key }))[0];
    if (!summary) return;
    if (action === "sources") {
      for (const p of sourcePages(summary.data))
        await tg.send(c.TELEGRAM_ADMIN_CHAT_ID, p);
    } else {
      const result = await db.rpc("radar_admin", {
        p_public: key,
        p_action: action,
        p_actor: String(callback.from.id),
        p_key: `callback:${callback.id}`,
      });
      await tg.call("answerCallbackQuery", {
        callback_query_id: callback.id,
        text:
          result === "ready" ? "Одобрено; публикация через очередь." : result,
      });
      return;
    }
    await tg.call("answerCallbackQuery", { callback_query_id: callback.id });
    return;
  }
  const message = update.message;
  if (!message || message.chat?.type !== "private") return;
  const match = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/.exec(
    message.text ?? "",
  );
  if (!match) return;
  const key = match[1],
    chat = String(message.chat.id);
  if (key === "methodology_v1") {
    await tg.send(chat, methodology);
    return;
  }
  if (key?.startsWith("sources_")) {
    const summary = (await db.all("summaries", { public_id: key.slice(8) }))[0];
    if (
      !summary ||
      (!summary.published_at && chat !== c.TELEGRAM_ADMIN_CHAT_ID)
    ) {
      await tg.send(chat, "Выпуск не найден или ещё не опубликован.");
      return;
    }
    for (const page of sourcePages(summary.data)) await tg.send(chat, page);
    return;
  }
  await tg.send(
    chat,
    "РАДАР М. Откройте «Источники» под выпуском канала или /start methodology_v1.",
  );
}
