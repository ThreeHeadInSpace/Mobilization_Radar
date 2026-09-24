import { route } from "../src/http.js";
export default async function handler(req: any, res: any) {
  const r = await route("/api/health", req.method, req.headers, req.body);
  res.setHeader("Cache-Control", "no-store");
  res.status(r.status).json(r.body);
}
