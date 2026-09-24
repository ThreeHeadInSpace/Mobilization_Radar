import { connection } from "./connection.js";
import { readFileSync } from "node:fs";
const sql = connection();
try {
  await sql.unsafe(readFileSync("tests/live-database.sql", "utf8"));
  console.log(
    "Live PostgreSQL: snapshot immutability, daily uniqueness, admin approval, publication lock and completion passed. Fixture transaction rolled back. No Telegram calls.",
  );
} catch (e) {
  console.log(
    JSON.stringify({
      status: "failed",
      code: (e as any).code ?? "connection_error",
    }),
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
