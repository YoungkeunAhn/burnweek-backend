/**
 * Gemini provider — the one non-OpenAI-compatible adapter (architecture/03).
 * Stubbed for Phase 1: the test provider is MiniMax (OpenAI-compatible). Wire
 * `@google/genai` here when Gemini is exercised. Kept behind the same port so
 * `LLM_PROVIDER=gemini` selects it without any caller change.
 */
import type { DraftRaw, DraftRequest, LLMConfig, LLMProvider } from "../types";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly capabilities = { streaming: true, jsonSchema: true };

  constructor(_cfg: LLMConfig) {
    // no-op until implemented
  }

  async generateDraft(_req: DraftRequest): Promise<DraftRaw> {
    throw new Error(
      "GeminiProvider.generateDraft not implemented (Phase 1 test provider = MiniMax). See architecture/03-llm-adapter.md.",
    );
  }
}
