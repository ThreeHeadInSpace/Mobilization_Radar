import { randomUUID } from "node:crypto";
import { config } from "../src/config/index.js";
import { SupabaseDB } from "../src/database/index.js";
import { route } from "../src/http.js";
const db = new SupabaseDB(config()),
  owner = randomUUID();
try {
  const sources = await db.all("sources", { active: true });
  const claimed = await db.rpc("radar_lock", {
    p_name: "smoke-readiness",
    p_owner: owner,
    p_seconds: 30,
  });
  const duplicate = await db.rpc("radar_lock", {
    p_name: "smoke-readiness",
    p_owner: randomUUID(),
    p_seconds: 30,
  });
  await db.rpc("radar_unlock", { p_name: "smoke-readiness", p_owner: owner });
  const health = await route("/api/health", "GET", {}, {});
  console.log(
    JSON.stringify({
      sources: sources.length,
      regions: new Set(sources.map((s) => s.region).filter(Boolean)).size,
      lock: claimed,
      duplicateBlocked: !duplicate,
      health: health.body,
    }),
  );
} catch {
  console.log("Live database smoke failed");
  process.exitCode = 1;
}
