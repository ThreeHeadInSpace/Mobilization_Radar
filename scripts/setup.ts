import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { config } from "../src/config/index.js";
import { Telegram } from "../src/telegram/index.js";
import { connection } from "./connection.js";
if (process.argv.includes("--local-secrets")) {
  for (const key of ["CRON_SECRET", "TELEGRAM_WEBHOOK_SECRET"])
    if (!process.env[key])
      appendFileSync(
        ".env.local",
        `\n${key}=${randomBytes(32).toString("hex")}\n`,
      );
  console.log("Local job/webhook secrets present. Values hidden.");
} else if (process.argv.includes("--activate")) {
  const c = config();
  if (
    !/^https:\/\//.test(c.APP_URL) ||
    c.CRON_SECRET.length < 24 ||
    c.TELEGRAM_WEBHOOK_SECRET.length < 24
  )
    throw new Error("Configure APP_URL and server secrets first");
  const sql = connection();
  try {
    const health = await fetch(`${c.APP_URL}/api/health`);
    if (!health.ok) throw new Error("health_failed");
    const tg = new Telegram(c);
    await tg.smoke();
    await tg.call("setWebhook", {
      url: `${c.APP_URL}/api/telegram`,
      secret_token: c.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query", "channel_post"],
      drop_pending_updates: false,
    });
    for (const [name, value] of [
      ["radar_app_url", c.APP_URL],
      ["radar_cron_secret", c.CRON_SECRET],
    ]) {
      const found = await sql`select id from vault.secrets where name=${name}`;
      if (found.length)
        await sql`select vault.update_secret(${found[0].id}::uuid,${value},${name})`;
      else await sql`select vault.create_secret(${value},${name})`;
    }
    await sql`select cron.schedule('radar-worker','* * * * *','select public.radar_tick()')`;
    console.log("Webhook and Supabase Cron activated");
  } catch {
    console.log(
      "Activation failed; inspect health and DB access. No secret values logged.",
    );
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
} else
  console.log(
    "Use --local-secrets to create local secrets; --activate after deployment to enable webhook and Cron.",
  );
