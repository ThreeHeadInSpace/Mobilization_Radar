import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { route } from "../src/http.js";
import handler from "../api/smoke.js";

const secret = "smoke-test-authorization-secret-123456";
const headers = { authorization: `Bearer ${secret}` };
const triage = {
  relevant: false,
  eventType: "routine",
  region: null,
  sourceRole: "unknown",
  primarySourceLikelihood: "unknown",
  novelty: "unknown",
  verificationHint: "none",
  needsDeepAnalysis: false,
};
type Options = {
  xaiStatus?: number;
  invalidAI?: boolean;
  badPermissions?: boolean;
  dbFailure?: boolean;
  logFailure?: boolean;
  telegramFailure?: boolean;
  getMeFailure?: boolean;
};
function installFetch(options: Options = {}) {
  const calls: { url: string; method: string; body: any; redirect: unknown }[] =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any = {}) => {
      const url = String(input),
        method = init.method ?? "GET",
        body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method, body, redirect: init.redirect });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("supabase.example.org")) {
        if (method === "GET" && url.includes("/rest/v1/config")) {
          if (options.dbFailure) throw new Error(`leak ${secret}`);
          return json([]);
        }
        if (method === "POST" && url.endsWith("/rest/v1/ai_usage?select=*")) {
          if (options.logFailure) throw new Error("private database detail");
          return json({ ...body, id: 1 }, 201);
        }
        throw new Error("Forbidden database operation");
      }
      if (url.startsWith("https://api.telegram.org/")) {
        if (options.telegramFailure) throw new Error(`leak ${url}`);
        const method = url.split("/").at(-1);
        if (method === "getMe")
          return json({
            ok: !options.getMeFailure,
            result: { id: 123, is_bot: true, username: "secret_bot_name" },
          });
        if (method === "getChat")
          return json({
            ok: true,
            result: {
              id: body.chat_id,
              type: body.chat_id === "test-admin" ? "private" : "channel",
              title: "private title",
            },
          });
        if (method === "getChatMember")
          return json({
            ok: true,
            result: {
              user: { id: 123 },
              status: "administrator",
              ...(options.badPermissions ? {} : { can_post_messages: true }),
            },
          });
        throw new Error("Forbidden Telegram operation");
      }
      if (url === "https://xai.example.org/v1/responses") {
        if (options.xaiStatus)
          return json(
            { error: `upstream secret: ${secret}` },
            options.xaiStatus,
          );
        return json({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: options.invalidAI ? "{}" : JSON.stringify(triage),
                },
              ],
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 30,
            cost_in_usd_ticks: 10000000,
          },
        });
      }
      throw new Error("Unexpected network request");
    }),
  );
  return calls;
}
beforeEach(() => {
  for (const [key, value] of Object.entries({
    CRON_SECRET: secret,
    SUPABASE_URL: "https://supabase.example.org",
    SUPABASE_SECRET_KEY: "sb_secret_smoke_test_only",
    TELEGRAM_BOT_TOKEN: "123:test-only-token",
    TELEGRAM_ADMIN_CHAT_ID: "test-admin",
    TELEGRAM_CHANNEL_ID: "test-channel",
    XAI_API_KEY: "test-xai-key",
    XAI_BASE_URL: "https://xai.example.org/v1",
    XAI_TRIAGE_MODEL: "test-model",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  undefined,
  "Bearer wrong",
  `Basic ${secret}`,
  `Bearer ${secret}extra`,
])(
  "rejects unauthorized smoke without any external calls: %s",
  async (authorization) => {
    const calls = installFetch();
    expect(
      (await route("/api/smoke", "POST", { authorization }, {})).status,
    ).toBe(401);
    expect(calls).toHaveLength(0);
  },
);
it("rejects missing server secret and GET without side effects", async () => {
  const calls = installFetch();
  vi.stubEnv("CRON_SECRET", "");
  expect(
    (await route("/api/smoke", "POST", { authorization: "Bearer " }, {}))
      .status,
  ).toBe(401);
  expect((await route("/api/smoke", "GET", headers, {})).status).toBe(405);
  expect(calls).toHaveLength(0);
});
it("runs read-only checks plus exactly one bounded AI request and usage insert", async () => {
  const calls = installFetch();
  const result = await route("/api/smoke", "POST", headers, {
    publish: true,
    model: "attacker-model",
    text: "attacker-input",
    url: "https://attacker.example",
  });
  expect(result.status).toBe(200);
  expect((result.body as any).ok).toBe(true);
  const ai = calls.filter((c) => c.url.includes("xai.example.org"));
  expect(ai).toHaveLength(1);
  expect(ai[0].body).toMatchObject({
    model: "test-model",
    store: false,
    max_output_tokens: 512,
  });
  expect(ai[0].body.tools).toBeUndefined();
  expect(JSON.stringify(ai[0].body)).not.toContain("attacker");
  expect(
    calls
      .filter((c) => c.url.includes("api.telegram.org"))
      .map((c) => c.url.split("/").at(-1))
      .sort(),
  ).toEqual(["getChat", "getChat", "getChatMember", "getMe"]);
  const writes = calls.filter(
    (c) => c.url.includes("supabase.example.org") && c.method !== "GET",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({
    operation: "smoke_triage",
    run_id: null,
    success: true,
    cost: 0.001,
  });
  expect(calls.every((c) => c.redirect === "error")).toBe(true);
  const output = JSON.stringify(result.body);
  for (const value of [
    secret,
    "test-only-token",
    "test-admin",
    "test-channel",
    "test-xai-key",
    "secret_bot_name",
    "private title",
    "sb_secret_smoke_test_only",
  ])
    expect(output).not.toContain(value);
});
it.each([{ xaiStatus: 403 }, { invalidAI: true }])(
  "does not retry a failed AI call and logs failure: %j",
  async (options) => {
    const calls = installFetch(options);
    const result = await route("/api/smoke", "POST", headers, {});
    expect(result.status).toBe(503);
    expect((result.body as any).checks.xai.status).toBe("failed");
    expect(calls.filter((c) => c.url.includes("xai.example.org"))).toHaveLength(
      1,
    );
    expect(calls.find((c) => c.url.includes("/ai_usage"))?.body.success).toBe(
      false,
    );
    expect(JSON.stringify(result.body)).not.toContain(secret);
  },
);
it("requires explicit channel posting permission", async () => {
  installFetch({ badPermissions: true });
  const result = await route("/api/smoke", "POST", headers, {});
  expect(result.status).toBe(503);
  expect((result.body as any).checks.telegramPermissions.status).toBe("failed");
});
it("continues independent checks after Telegram and database failures", async () => {
  const calls = installFetch({ telegramFailure: true, dbFailure: true });
  const result = await route("/api/smoke", "POST", headers, {});
  const checks = (result.body as any).checks;
  expect(result.status).toBe(503);
  expect(checks.supabase.status).toBe("failed");
  expect(checks.telegramPermissions.status).toBe("skipped");
  expect(checks.xai.status).toBe("ok");
  expect(calls.filter((c) => c.url.includes("xai.example.org"))).toHaveLength(
    1,
  );
  expect(JSON.stringify(result.body)).not.toContain("test-only-token");
});
it("does not repeat AI if usage logging fails", async () => {
  const calls = installFetch({ logFailure: true });
  const result = await route("/api/smoke", "POST", headers, {});
  expect(result.status).toBe(503);
  expect((result.body as any).checks.aiUsage.code).toBe("usage_logging_failed");
  expect((result.body as any).checks.xai.status).toBe("ok");
  expect(calls.filter((c) => c.url.includes("xai.example.org"))).toHaveLength(
    1,
  );
});
it("does not send AI request when its key is missing", async () => {
  const calls = installFetch();
  vi.stubEnv("XAI_API_KEY", "");
  const result = await route("/api/smoke", "POST", headers, {});
  expect(result.status).toBe(503);
  expect((result.body as any).checks.xai.code).toBe("configuration_missing");
  expect(calls.filter((c) => c.url.includes("xai.example.org"))).toHaveLength(
    0,
  );
  expect(calls.filter((c) => c.url.includes("/ai_usage"))).toHaveLength(0);
});
it("sets no-store even for unauthorized serverless requests", async () => {
  const calls = installFetch();
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  await handler({ method: "POST", headers: {} }, res);
  expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  expect(res.status).toHaveBeenCalledWith(401);
  expect(calls).toHaveLength(0);
});
