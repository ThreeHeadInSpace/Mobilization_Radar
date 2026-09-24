import { route } from "../src/http.js";
export default async function handler(req: any, res: any) {
  const r = await route("/api/jobs", req.method, req.headers, req.body);
  res.status(r.status).json(r.body);
}
