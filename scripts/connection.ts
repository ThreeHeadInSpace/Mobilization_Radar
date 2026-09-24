import postgres from "postgres";
import "../src/config/index.js";
export function connection() {
  const supplied = process.env.DATABASE_URL;
  if (supplied)
    return postgres(supplied, {
      ssl: "require",
      max: 1,
      connect_timeout: 15,
      onnotice: () => {},
    });
  const base = process.env.SUPABASE_URL ?? "";
  const ref = new URL(base).hostname.split(".")[0];
  if (!process.env.SUPABASE_DB_PASSWORD)
    throw new Error("missing_database_password");
  return postgres({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    user: "postgres",
    password: process.env.SUPABASE_DB_PASSWORD,
    database: "postgres",
    ssl: "require",
    max: 1,
    connect_timeout: 15,
    onnotice: () => {},
  });
}
