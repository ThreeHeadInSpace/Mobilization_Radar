import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { config } from "../src/config/index.js";
import { connection } from "./connection.js";
import { activate, ActivationError } from "./activation.js";
import { configureScheduler } from "./scheduler.js";
if (process.argv.includes("--local-secrets")) {
  for (const key of ["CRON_SECRET", "TELEGRAM_WEBHOOK_SECRET"])
    if (!process.env[key])
      appendFileSync(
        ".env.local",
        `\n${key}=${randomBytes(32).toString("hex")}\n`,
      );
  console.log("Local job/webhook secrets present. Values hidden.");
} else if (process.argv.includes("--activate")) {
  try {
    await activate(config(), async (origin, secret) => {
      const sql = connection();
      try {
        await configureScheduler(sql, origin, secret);
      } finally {
        await sql.end();
      }
    });
    console.log("Webhook and Supabase Cron activated");
  } catch (e) {
    console.log(
      `Activation failed: ${e instanceof ActivationError ? e.message : "configuration_or_connection_error"}. No secret values logged.`,
    );
    process.exitCode = 1;
  }
} else
  console.log(
    "Use --local-secrets to create local secrets; --activate after deployment to enable webhook and Cron.",
  );
