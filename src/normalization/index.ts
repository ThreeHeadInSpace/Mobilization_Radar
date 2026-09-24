import { createHash, randomBytes } from "node:crypto";
export function normalizeUrl(input: string): string {
  const u = new URL(input);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error("invalid_url");
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const k of [...u.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$|yclid$|_openstat$|ref$|referrer$)/i.test(k))
      u.searchParams.delete(k);
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  return u.toString();
}
export const hash = (s: string) =>
  createHash("sha256")
    .update(s.replace(/\s+/g, " ").trim().toLowerCase())
    .digest("hex");
export function publicId() {
  return randomBytes(12).toString("hex");
}
export function uniqueArticles<
  T extends { canonical_url: string; content_hash: string },
>(items: T[]): T[] {
  const urls = new Set<string>(),
    hashes = new Set<string>();
  return items.filter((a) => {
    if (urls.has(a.canonical_url) || hashes.has(a.content_hash)) return false;
    urls.add(a.canonical_url);
    hashes.add(a.content_hash);
    return true;
  });
}
