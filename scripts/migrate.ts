import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connection } from "./connection.js";
const sql = connection();
try {
  await sql`create schema if not exists radar_migrations`;
  await sql`create table if not exists radar_migrations.applied(name text primary key, hash text not null, applied_at timestamptz not null default now())`;
  for (const name of readdirSync("supabase/migrations")
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const content = readFileSync(`supabase/migrations/${name}`, "utf8"),
      hash = createHash("sha256").update(content).digest("hex");
    const applied =
      await sql`select hash from radar_migrations.applied where name=${name}`;
    if (applied.length) {
      if (applied[0].hash !== hash)
        throw new Error("migration_checksum_mismatch");
      continue;
    }
    const history =
      await sql`select to_regclass('supabase_migrations.schema_migrations') as present`;
    if (history[0].present) {
      const existing =
        await sql`select name from supabase_migrations.schema_migrations where name=${name.replace(/^\d+_/, "").replace(/\.sql$/, "")}`;
      if (existing.length) {
        await sql`insert into radar_migrations.applied(name,hash) values(${name},${hash})`;
        console.log(`Registered existing Supabase migration ${name}`);
        continue;
      }
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`insert into radar_migrations.applied(name,hash) values(${name},${hash})`;
    });
    console.log(`Applied ${name}`);
  }
  console.log("Migrations verified");
} catch (e) {
  console.log(
    JSON.stringify({
      status: "migration_failed",
      code: (e as any).code ?? "connection_or_checksum_error",
    }),
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
