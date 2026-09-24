import { config as dotenv } from "dotenv";
import { z } from "zod";
dotenv({ path: ".env.local", quiet: true });
const bool = (fallback: boolean) =>
  z.preprocess(
    (v) =>
      v === undefined || v === ""
        ? fallback
        : v === "true"
          ? true
          : v === "false"
            ? false
            : v,
    z.boolean(),
  );
export const envSchema = z.object({
  SUPABASE_URL: z.string().default(""),
  SUPABASE_SECRET_KEY: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHANNEL_ID: z.string().default(""),
  TELEGRAM_ADMIN_CHAT_ID: z.string().default(""),
  TELEGRAM_OWNER_ID: z.string().default(""),
  XAI_API_KEY: z.string().default(""),
  XAI_BASE_URL: z.string().default("https://api.x.ai/v1"),
  XAI_TRIAGE_MODEL: z.string().default("grok-4.3"),
  XAI_SYNTHESIS_MODEL: z.string().default("grok-4.3"),
  APP_TIMEZONE: z.string().default("Europe/Moscow"),
  CRON_SECRET: z.string().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  APP_URL: z.string().default(""),
  REQUIRE_REVIEW_ALL: bool(true),
  AUTO_PUBLISH_SAFE_REPORTS: bool(false),
  ENABLE_WEB_SEARCH: bool(true),
  MONTHLY_AI_BUDGET_USD: z.coerce.number().nonnegative().default(20),
  MIN_COVERAGE: z.coerce.number().min(0).max(1).default(0.6),
  REVIEW_LEVEL: z.coerce.number().min(0).max(5).default(2),
  STRONG_CHAINS: z.coerce.number().min(2).default(3),
  FEDERAL_REGIONS: z.coerce.number().min(2).default(3),
  PUBLICATION_TIME: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default("18:00"),
  MONITOR_HOURS: z.string().default("08,15"),
});
export type Config = z.infer<typeof envSchema>;
export function config(): Config {
  const values = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== ""),
  );
  const c = envSchema.parse(values);
  new Intl.DateTimeFormat("ru", { timeZone: c.APP_TIMEZONE });
  return c;
}
export function day(now = new Date(), timezone = "Europe/Moscow") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function clock(now: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}
export function required(c: Config, keys: (keyof Config)[]) {
  if (keys.some((k) => !c[k])) throw new Error("configuration_missing");
}
