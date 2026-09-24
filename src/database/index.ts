import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "../config/index.js";
export interface DB {
  all(
    table: string,
    filters?: Record<string, unknown>,
    order?: string,
    limit?: number,
  ): Promise<any[]>;
  put(
    table: string,
    row: Record<string, unknown>,
    conflict?: string,
  ): Promise<any>;
  patch(
    table: string,
    filter: Record<string, unknown>,
    row: Record<string, unknown>,
  ): Promise<void>;
  rpc(name: string, args: Record<string, unknown>): Promise<any>;
}
export class SupabaseDB implements DB {
  client: SupabaseClient;
  constructor(c: Config) {
    this.client = createClient(c.SUPABASE_URL, c.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  async all(
    table: string,
    filters: Record<string, unknown> = {},
    order?: string,
    limit = 1000,
  ) {
    let q = this.client.from(table).select("*");
    for (const [k, v] of Object.entries(filters))
      q = v === null ? q.is(k, null) : q.eq(k, v);
    if (order) q = q.order(order, { ascending: false, nullsFirst: false });
    const { data, error } = await q.limit(limit);
    if (error) throw new Error(`database_read_${error.code}`);
    return data ?? [];
  }
  async put(table: string, row: Record<string, unknown>, conflict?: string) {
    const q = conflict
      ? this.client.from(table).upsert(row, { onConflict: conflict })
      : this.client.from(table).insert(row);
    const { data, error } = await q.select().single();
    if (error) throw new Error(`database_write_${error.code}`);
    return data;
  }
  async patch(
    table: string,
    filter: Record<string, unknown>,
    row: Record<string, unknown>,
  ) {
    let q = this.client.from(table).update(row);
    for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
    const { error } = await q;
    if (error) throw new Error(`database_update_${error.code}`);
  }
  async rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await this.client.rpc(name, args);
    if (error) throw new Error(`database_rpc_${error.code}`);
    return data;
  }
}
