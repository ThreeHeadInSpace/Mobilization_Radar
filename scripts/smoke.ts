import { config } from "../src/config/index.js";
import { Telegram } from "../src/telegram/index.js";
import { SupabaseDB } from "../src/database/index.js";
import { XAIProvider } from "../src/providers/xai-provider.js";
import { collect } from "../src/collectors/index.js";
import { readFileSync } from "node:fs";
const c = config();
const results: Record<string, unknown> = {};
try {
  await new Telegram(c).smoke();
  results.telegram = "getMe, admin chat, channel rights: ok";
} catch (e) {
  results.telegram =
    e instanceof Error && /^telegram_/.test(e.message)
      ? e.message
      : "network_or_configuration_error";
}
try {
  await new SupabaseDB(c).all("config", {}, undefined, 1);
  results.database = "ok";
} catch {
  results.database = "connection_or_migrations_missing";
}
const sources = JSON.parse(readFileSync("data/sources.json", "utf8"));
for (const s of sources
  .filter((s: any) => s.collection_method === "rss")
  .slice(0, 2)) {
  const result = await collect(s);
  results[`collector:${s.id}`] = {
    status: result.status,
    items: result.itemsDiscovered,
    error: result.errorCode,
  };
}
if (process.argv.includes("--ai")) {
  const provider = new XAIProvider(c, async (usage) => {
    await new SupabaseDB(c).put("ai_usage", { ...usage, run_id: null });
    console.log(JSON.stringify({ ai_usage: usage }));
  });
  try {
    const r = await provider.triage({
      id: "smoke",
      source_id: "fixture",
      canonical_url: "https://example.org/test",
      original_url: "https://example.org/test",
      title: "Тест обычного воинского учёта",
      published_at: null,
      discovered_at: new Date().toISOString(),
      text: "Учебный тест: проводится плановое уточнение данных воинского учёта. Новых событий и необычных мероприятий нет.",
      content_hash: "test",
      region: null,
      raw_metadata: { links: [] },
    });
    results.ai = { status: "ok", relevant: r.relevant };
  } catch {
    results.ai = "analysis_failed";
  }
}
console.log(JSON.stringify(results, null, 2));
