/**
 * Provider selection + fallback (architecture/03-llm-adapter.md).
 * Chooses the implementation from injected config (`LLM_PROVIDER`). MiniMax and
 * GPT both resolve to the single OpenAI-compatible adapter (baseUrl swap).
 * Hive(DeepSeek·GLM · D105 ②) too — it takes the same non-streaming body with
 * `response_format: json_object` (probed 2026-10-16, backlog 07 §4.3).
 */
import type { LLMConfig, LLMProvider } from "./types";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { GeminiProvider } from "./providers/gemini";

export function createProvider(cfg: LLMConfig): LLMProvider {
  switch (cfg.provider) {
    case "minimax":
    case "gpt":
    case "openai":
    case "hive":
      return new OpenAICompatibleProvider(cfg);
    case "gemini":
      return new GeminiProvider(cfg);
    default:
      throw new Error(
        `Unknown LLM_PROVIDER='${cfg.provider}'. Expected minimax | gpt | openai | hive | gemini.`,
      );
  }
}
