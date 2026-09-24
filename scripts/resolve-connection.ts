import postgres from "postgres";
import { appendFileSync } from "node:fs";
import { config } from "../src/config/index.js";
const c = config();
const region = process.argv[2];
if (!/^[a-z]+-[a-z]+-\d$/.test(region ?? ""))
  throw new Error("Pass the verified Supabase region");
const ref = new URL(c.SUPABASE_URL).hostname.split(".")[0];
let connected = false;
for (const n of [1, 0]) {
  const url = new URL(
    `postgresql://aws-${n}-${region}.pooler.supabase.com:5432/postgres`,
  );
  url.username = `postgres.${ref}`;
  url.password = process.env.SUPABASE_DB_PASSWORD ?? "";
  const sql = postgres(url.toString(), {
    ssl: "require",
    max: 1,
    connect_timeout: 8,
    onnotice: () => {},
  });
  try {
    await sql`select 1`;
    if (!process.env.DATABASE_URL)
      appendFileSync(".env.local", `\nDATABASE_URL=${url.toString()}\n`);
    connected = true;
    console.log(
      "Verified session-pooler connection saved locally; credentials hidden.",
    );
    break;
  } catch (e) {
    console.log(
      JSON.stringify({
        poolerAttempt: n,
        code: (e as any).code ?? "connection_failed",
      }),
    );
  } finally {
    await sql.end({ timeout: 1 });
  }
}
if (!connected) process.exitCode = 1;
