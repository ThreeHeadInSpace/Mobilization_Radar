import { route } from "../src/http.js";
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  const result = await route(
    "/api/manual-review",
    req.method,
    req.headers,
    undefined,
  );
  res.status(result.status).json(result.body);
}
