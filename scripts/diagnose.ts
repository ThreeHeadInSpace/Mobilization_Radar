import { config } from "../src/config/index.js";
import { lookup } from "node:dns/promises";
const c = config();
const clean = (value: string) => {
  let s = value;
  for (const [k, v] of Object.entries(process.env))
    if (
      /KEY|TOKEN|SECRET|PASSWORD|CHAT_ID|CHANNEL_ID|OWNER_ID/.test(k) &&
      v &&
      v.length > 3
    )
      s = s.split(v).join("[redacted]");
  return s.replace(/https?:\/\/[^\s"<>]+/g, "[url]").slice(0, 500);
};
for (const [name, url, init] of [
  ["telegram", `https://api.telegram.org/bot${c.TELEGRAM_BOT_TOKEN}/getMe`, {}],
  [
    "supabase",
    `${c.SUPABASE_URL}/rest/v1/`,
    { headers: { apikey: c.SUPABASE_SECRET_KEY } },
  ],
  [
    "xai",
    `${c.XAI_BASE_URL}/models`,
    { headers: { Authorization: `Bearer ${c.XAI_API_KEY}` } },
  ],
] as const) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    console.log(
      JSON.stringify({
        name,
        status: r.status,
        error: r.ok ? null : clean(await r.text()),
      }),
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        name,
        error: (e as any).cause?.code ?? (e as any).name,
      }),
    );
  }
}
const u = new URL(c.SUPABASE_URL);
console.log(
  JSON.stringify({
    supabaseUrlIsProjectHost: /^[a-z]{20}\.supabase\.co$/.test(u.hostname),
    supabasePathEmpty: u.pathname === "/",
    xaiBaseMatchesOfficial: c.XAI_BASE_URL === "https://api.x.ai/v1",
    telegramTokenShape: /^\d+:[A-Za-z0-9_-]+$/.test(c.TELEGRAM_BOT_TOKEN),
  }),
);
try {
  await lookup(`db.${u.hostname.split(".")[0]}.supabase.co`);
  console.log("database_dns_ok");
} catch (e) {
  console.log(JSON.stringify({ databaseDns: (e as any).code }));
}
