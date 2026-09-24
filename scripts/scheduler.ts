import type { Sql } from "postgres";
export async function configureScheduler(
  sql: Sql,
  origin: string,
  secret: string,
) {
  await sql.begin(async (tx) => {
    // Serialize repeated/concurrent activations; roll back Vault changes if scheduling fails.
    await tx`select pg_advisory_xact_lock(7261646172)`;
    for (const [name, value] of [
      ["radar_app_url", origin],
      ["radar_cron_secret", secret],
    ]) {
      const existing =
        await tx`select id, decrypted_secret = ${value} as matches from vault.decrypted_secrets where name=${name}`;
      if (existing.length > 1) throw new Error("duplicate_vault_entries");
      if (existing.length) {
        if (existing[0].matches) continue;
        // Activation must never rotate a previously stored credential.
        if (name === "radar_cron_secret")
          throw new Error("vault_secret_mismatch");
        await tx`select vault.update_secret(${existing[0].id}::uuid,${value},${name})`;
      } else await tx`select vault.create_secret(${value},${name})`;
    }
    // pg_cron upserts the named job for the same DB user instead of creating duplicates.
    await tx`select cron.schedule('radar-worker','* * * * *','select public.radar_tick()')`;
  });
}
