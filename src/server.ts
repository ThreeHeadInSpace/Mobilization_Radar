import { createServer } from "node:http";
import { route } from "./http.js";
createServer(async (req, res) => {
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    let body = {};
    if (size) body = JSON.parse(Buffer.concat(chunks).toString());
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [
        k,
        Array.isArray(v) ? v[0] : v,
      ]),
    );
    const result = await route(
      new URL(req.url ?? "/", "http://localhost").pathname,
      req.method ?? "GET",
      headers,
      body,
    );
    res.writeHead(result.status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(result.body));
  } catch {
    res.writeHead(400).end('{"error":"invalid_request"}');
  }
}).listen(3000, "127.0.0.1", () =>
  console.log("РАДАР М: http://localhost:3000/api/health"),
);
