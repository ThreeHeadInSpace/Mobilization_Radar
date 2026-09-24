import { route } from "../src/http.js";
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  const r = await route("/api/smoke", req.method, req.headers, undefined);
  res.status(r.status).json(r.body);
}
