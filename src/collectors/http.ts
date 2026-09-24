import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
export class FetchFailure extends Error {
  constructor(
    public code: string,
    public status: number | null = null,
  ) {
    super(code);
  }
}
export async function assertPublic(url: string) {
  const u = new URL(url);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port))
  )
    throw new FetchFailure("unsafe_url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (
    !ips.length ||
    ips.some(({ address: a }) => {
      if (a.includes(":")) return !/^2[0-9a-f]{3}:/i.test(a);
      const p = a.split(".").map(Number);
      return (
        p[0] === 0 ||
        p[0] === 10 ||
        p[0] === 127 ||
        p[0] >= 224 ||
        (p[0] === 169 && p[1] === 254) ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
        (p[0] === 192 && p[1] === 168) ||
        (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
      );
    })
  )
    throw new FetchFailure("private_address");
}
export async function getText(
  url: string,
): Promise<{ text: string; status: number }> {
  let current = url;
  const signal = AbortSignal.timeout(10000);
  for (let i = 0; i < 4; i++) {
    await assertPublic(current);
    const r = await fetch(current, {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "RadarM/0.1 (public-source monitoring)",
        Accept:
          "text/html,application/rss+xml,application/atom+xml,application/xml",
      },
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const location = r.headers.get("location");
      if (!location) throw new FetchFailure("redirect");
      current = new URL(location, current).toString();
      await r.body?.cancel();
      continue;
    }
    if (!r.ok) throw new FetchFailure("http_error", r.status);
    const reader = r.body?.getReader();
    if (!reader) throw new FetchFailure("empty");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new FetchFailure("too_large");
      }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString("utf8"), status: r.status };
  }
  throw new FetchFailure("redirect_limit");
}
