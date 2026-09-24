import type { DB } from "../database/index.js";
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function manualReview(
  db: DB,
  action: "prepare" | "confirm" | "cancel" | "direct",
  token: string,
  actor: string,
) {
  return db.rpc("radar_manual_review", {
    p_action: action,
    p_token: token,
    p_actor: actor,
  });
}
