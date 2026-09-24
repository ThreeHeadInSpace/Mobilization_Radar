import { it, expect } from "vitest";
import { XAIProvider } from "../src/providers/xai-provider.js";
import { cfg, article } from "./fixtures.js";
it("Responses structured output validates and records actual billed ticks", async () => {
  const usage: any[] = [];
  let body: any;
  const provider = new XAIProvider(
    cfg,
    async (u) => {
      usage.push(u);
    },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    relevant: false,
                    eventType: "routine",
                    region: null,
                    sourceRole: "unknown",
                    primarySourceLikelihood: "unknown",
                    novelty: "unknown",
                    verificationHint: "none",
                    needsDeepAnalysis: false,
                  }),
                },
              ],
            },
          ],
          usage: {
            input_tokens: 20,
            output_tokens: 10,
            cost_in_usd_ticks: 10000000,
          },
        }),
      );
    },
  );
  expect((await provider.triage(article())).relevant).toBe(false);
  expect(body.text.format.type).toBe("json_schema");
  expect(body.store).toBe(false);
  expect(usage[0].cost).toBe(0.001);
});
it("invalid model output is retried then fails closed", async () => {
  let calls = 0;
  const usage: any[] = [];
  const provider = new XAIProvider(
    cfg,
    async (u) => {
      usage.push(u);
    },
    async () => {
      calls++;
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"level":5}' }],
            },
          ],
        }),
      );
    },
  );
  await expect(provider.triage(article())).rejects.toThrow("analysis_failed");
  expect(calls).toBe(2);
  expect(usage.every((u) => !u.success)).toBe(true);
});
