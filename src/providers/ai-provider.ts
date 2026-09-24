import type { z } from "zod";
import type { Article } from "../domain.js";
import { analysisSchema, triageSchema } from "../domain.js";
export interface AIProvider {
  triage(article: Article): Promise<z.infer<typeof triageSchema>>;
  analyze(
    articles: Article[],
    history: unknown[],
  ): Promise<z.infer<typeof analysisSchema>>;
  search?(): Promise<string[]>;
}
export type Usage = {
  provider: string;
  model: string;
  operation: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  duration: number;
  success: boolean;
  error_code: string | null;
};
