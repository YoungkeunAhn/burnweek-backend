/**
 * Provider-agnostic LLM port (INV-4, ADR-0006, architecture/03-llm-adapter.md).
 *
 * The LLM produces ONLY a DraftPlan (numeric-light — no weights/sets/rest/%1RM).
 * Code owns all numbers and safety (INV-1). Vendor SDKs are imported ONLY inside
 * `providers/*` — nothing outside this folder may know which vendor is active.
 */

/** What the caller hands a provider for one draft generation. */
export interface DraftRequest {
  /** Cacheable system prefix: programming rules + DraftPlan schema + safety guards. */
  systemPrefix: string;
  /** Variable user turn: profile + prior-week logs (compact, XML-delimited). */
  userContext: string;
  /** The DraftPlan JSON Schema the model must satisfy (for native structured output). */
  draftSchema: Record<string, unknown>;
  /** Optional repair feedback appended on a retry (schema errors from the last attempt). */
  repairFeedback?: string;
}

/** Raw provider result — `draft` is unvalidated; code validates against the schema next. */
export interface DraftRaw {
  draft: unknown;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** Provider-native raw payload, kept for debugging/eval; never trusted directly. */
  raw?: unknown;
}

export interface LLMProvider {
  readonly name: string; // 'minimax' | 'gpt' | 'gemini'
  readonly capabilities: {
    streaming: boolean;
    /** Native structured-output (JSON Schema) support. If false, we prompt+prefill. */
    jsonSchema: boolean;
    maxContextTokens?: number;
  };
  /** Generate a DraftPlan (numeric-light). Throws on transport/provider failure. */
  generateDraft(req: DraftRequest): Promise<DraftRaw>;
}

/** Runtime config injected into providers (ADR-0008 portability — no global reads). */
export interface LLMConfig {
  provider: string; // LLM_PROVIDER
  apiKey: string; // LLM_API_KEY (backend-only, INV-3)
  baseUrl: string; // LLM_BASE_URL (OpenAI-compatible host for MiniMax/GPT)
  model: string; // LLM_MODEL
  /** Generic switch; each vendor adapter decides whether/how it can honour it. */
  reasoningMode?: "adaptive" | "disabled"; // LLM_REASONING_MODE
  /** Shared by both A/B arms so reasoning and output-length effects do not mix. */
  maxCompletionTokens?: number; // LLM_MAX_COMPLETION_TOKENS
}
