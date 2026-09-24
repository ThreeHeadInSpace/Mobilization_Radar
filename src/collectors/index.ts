import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { randomUUID } from "node:crypto";
import type { Article, CollectorResult, Source } from "../domain.js";
import { normalizeUrl, hash, uniqueArticles } from "../normalization/index.js";
import { getText, FetchFailure } from "./http.js";
const keywords =
  /мобилиз|повест|военком|воинск|запасник|резервист|военн.{0,15}сбор|контрактник/i;
const date = (v: unknown) =>
  typeof v === "string" && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : null;
const plain = (s: string) => load(s).text().replace(/\s+/g, " ").trim();
function article(
  source: Source,
  url: string,
  title: string,
  text: string,
  published: string | null,
  links: string[] = [],
): Article {
  return {
    id: randomUUID(),
    source_id: source.id,
    canonical_url: normalizeUrl(url),
    original_url: url,
    title: title.slice(0, 300),
    text: text.slice(0, 9000),
    published_at: published,
    discovered_at: new Date().toISOString(),
    content_hash: hash(text),
    region: source.region,
    raw_metadata: { links },
  };
}
export function parseFeed(text: string, source: Source): Article[] {
  const root = new XMLParser({ ignoreAttributes: false }).parse(text);
  const raw = root.rss?.channel?.item ?? root.feed?.entry ?? [];
  return (Array.isArray(raw) ? raw : [raw]).flatMap((x: any) => {
    try {
      const link =
        typeof x.link === "string"
          ? x.link
          : (Array.isArray(x.link) ? x.link[0] : x.link)?.["@_href"];
      const body = plain(
        String(
          x["content:encoded"] ?? x.description ?? x.summary ?? x.content ?? "",
        ),
      );
      const title = plain(String(x.title ?? ""));
      if (!link) return [];
      return [
        article(
          source,
          new URL(link, source.base_url).toString(),
          title,
          `${title}. ${body}`,
          date(x.pubDate ?? x.published ?? x.updated),
        ),
      ];
    } catch {
      return [];
    }
  });
}
export function parsePage(
  text: string,
  source: Source,
  url = source.base_url,
): Article | null {
  const $ = load(text);
  $("script,style,nav,footer,header,noscript").remove();
  const title =
    $('meta[property="og:title"]').attr("content") ??
    $("h1").first().text() ??
    $("title").text();
  const body = (
    $("article").first().text() ||
    $("main").first().text() ||
    $("body").text()
  )
    .replace(/\s+/g, " ")
    .trim();
  if (
    body.length < 100 ||
    /captcha|access denied|checking your browser/i.test(body.slice(0, 300))
  )
    return null;
  const published = date(
    $('meta[property="article:published_time"]').attr("content") ??
      $("time").first().attr("datetime"),
  );
  const links = $("a[href]")
    .toArray()
    .flatMap((a) => {
      try {
        return [normalizeUrl(new URL($(a).attr("href")!, url).toString())];
      } catch {
        return [];
      }
    })
    .slice(0, 100);
  return article(source, url, title || "Публикация", body, published, links);
}
export async function collect(
  source: Source,
  fetcher = getText,
): Promise<CollectorResult> {
  const start = Date.now();
  let retries = 0;
  let code: number | null = null;
  if (source.collection_method === "manual")
    return {
      sourceId: source.id,
      status: "unsupported",
      httpCode: null,
      errorCode: "manual_source",
      duration: 0,
      itemsDiscovered: 0,
      retryCount: 0,
      articles: [],
    };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url =
        source.collection_method === "telegram"
          ? source.base_url.replace("t.me/", "t.me/s/")
          : source.base_url;
      const r = await fetcher(url);
      code = r.status;
      let articles: Article[] = [];
      let partial = false;
      if (source.collection_method === "rss")
        articles = parseFeed(r.text, source);
      else if (source.collection_method === "telegram") {
        const $ = load(r.text);
        $(".tgme_widget_message").each((_, node) => {
          const n = $(node),
            text = n.find(".tgme_widget_message_text").text();
          const link = n.find(".tgme_widget_message_date").attr("href");
          if (link && text)
            articles.push(
              article(
                source,
                link,
                text.slice(0, 140),
                text,
                date(n.find("time").attr("datetime")),
                n
                  .find(".tgme_widget_message_text a[href]")
                  .toArray()
                  .map((x) => $(x).attr("href")!)
                  .filter((x) => /^https?:/.test(x)),
              ),
            );
        });
      } else {
        const $ = load(r.text);
        const targets = $("a[href]")
          .toArray()
          .filter((a) => keywords.test($(a).text()))
          .flatMap((a) => {
            try {
              const u = new URL($(a).attr("href")!, url);
              return u.hostname.replace(/^www\./, "") ===
                new URL(url).hostname.replace(/^www\./, "")
                ? [u.toString()]
                : [];
            } catch {
              return [];
            }
          });
        const links = [...new Set(targets)].slice(0, 5);
        if (!links.length) {
          const a = parsePage(r.text, source);
          if (a?.published_at) articles.push(a);
          else partial = true;
        }
        for (const target of links) {
          try {
            const a = parsePage((await fetcher(target)).text, source, target);
            if (a) articles.push(a);
            else partial = true;
          } catch {
            partial = true;
          }
        }
      }
      if (!articles.length) partial = true;
      const recent = uniqueArticles(articles)
        .filter(
          (a) =>
            !a.published_at ||
            Date.parse(a.published_at) >= Date.now() - 48 * 3600000,
        )
        .slice(0, 20);
      return {
        sourceId: source.id,
        status: partial ? "partial" : "ok",
        httpCode: code,
        errorCode: partial ? "extraction_incomplete" : null,
        duration: Date.now() - start,
        itemsDiscovered: recent.length,
        retryCount: retries,
        articles: recent,
      };
    } catch (e) {
      code = e instanceof FetchFailure ? e.status : null;
      if (attempt === 1)
        return {
          sourceId: source.id,
          status: "error",
          httpCode: code,
          errorCode: e instanceof FetchFailure ? e.code : "network_error",
          duration: Date.now() - start,
          itemsDiscovered: 0,
          retryCount: retries,
          articles: [],
        };
      retries++;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("collector_failed");
}
