import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import type { DB } from "../src/database/index.js";
const ident = (s: string) => {
  if (!/^[a-z_]+$/.test(s)) throw new Error("bad_identifier");
  return `"${s}"`;
};
export class TestDB implements DB {
  constructor(public pg: PGlite) {}
  static async create() {
    const pg = new PGlite();
    await pg.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    await pg.exec(
      readFileSync("supabase/migrations/20260924192002_radar_core.sql", "utf8"),
    );
    const reliability = readFileSync(
      "supabase/migrations/20260924194434_radar_reliability.sql",
      "utf8",
    );
    await pg.exec(
      reliability.slice(
        reliability.indexOf(
          "create or replace function public.radar_finish_publication",
        ),
      ),
    );
    await pg.exec(
      readFileSync(
        "supabase/migrations/20260924195049_radar_usage_totals.sql",
        "utf8",
      ),
    );
    return new TestDB(pg);
  }
  async all(
    table: string,
    filter: Record<string, unknown> = {},
    order?: string,
    limit = 1000,
  ) {
    const values: unknown[] = [];
    const conditions = Object.entries(filter).map(([k, v]) =>
      v === null
        ? `${ident(k)} is null`
        : (values.push(v), `${ident(k)}=$${values.length}`),
    );
    return (
      await this.pg.query(
        `select * from ${ident(table)}${conditions.length ? " where " + conditions.join(" and ") : ""}${order ? ` order by ${ident(order)} desc` : ""} limit ${limit}`,
        values,
      )
    ).rows as any[];
  }
  async put(table: string, row: Record<string, unknown>, conflict?: string) {
    const keys = Object.keys(row);
    const values = keys.map((k) =>
      typeof row[k] === "object" && row[k] !== null
        ? JSON.stringify(row[k])
        : row[k],
    );
    const update = conflict
      ? ` on conflict (${conflict.split(",").map(ident).join(",")}) do update set ${keys.map((k) => `${ident(k)}=excluded.${ident(k)}`).join(",")}`
      : "";
    return (
      await this.pg.query(
        `insert into ${ident(table)}(${keys.map(ident).join(",")}) values(${keys.map((_, i) => `$${i + 1}`).join(",")})${update} returning *`,
        values,
      )
    ).rows[0];
  }
  async patch(
    table: string,
    filter: Record<string, unknown>,
    row: Record<string, unknown>,
  ) {
    const entries = Object.entries(row),
      conditions = Object.entries(filter),
      values = [...entries, ...conditions].map(([, v]) =>
        typeof v === "object" && v !== null ? JSON.stringify(v) : v,
      );
    await this.pg.query(
      `update ${ident(table)} set ${entries.map(([k], i) => `${ident(k)}=$${i + 1}`).join(",")} where ${conditions.map(([k], i) => `${ident(k)}=$${entries.length + i + 1}`).join(" and ")}`,
      values,
    );
  }
  async rpc(name: string, args: Record<string, unknown>) {
    const pairs = Object.entries(args);
    const values = pairs.map(([, v]) =>
      typeof v === "object" && v !== null ? JSON.stringify(v) : v,
    );
    const result = await this.pg.query(
      `select ${ident(name)}(${pairs.map(([k], i) => `${ident(k)}=>$${i + 1}`).join(",")}) as result`,
      values,
    );
    return (result.rows[0] as any).result;
  }
}
