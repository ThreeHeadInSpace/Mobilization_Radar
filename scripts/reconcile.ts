import { config } from "../src/config/index.js";
import { SupabaseDB } from "../src/database/index.js";
const [key, messageId] = process.argv.slice(2);
if (!key || !/^\d+$/.test(messageId ?? ""))
  throw new Error(
    "Usage: npm run reconcile -- PUBLIC_ID VERIFIED_TELEGRAM_MESSAGE_ID",
  );
const c = config(),
  db = new SupabaseDB(c);
const summary = (await db.all("summaries", { public_id: key }))[0];
if (!summary) throw new Error("summary_not_found");
const q = (await db.all("publication_queue", { summary_id: summary.id }))[0];
if (!["unknown", "sending"].includes(q.status))
  throw new Error("not_ambiguous");
await db.rpc("radar_finish_publication", {
  p_summary: summary.id,
  p_attempt: q.attempt_id,
  p_message: Number(messageId),
  p_channel: c.TELEGRAM_CHANNEL_ID,
});
console.log("Existing Telegram message recorded. No message sent.");
