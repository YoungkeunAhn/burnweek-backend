/**
 * OpenAI-compatible provider — covers MiniMax AND GPT via `baseUrl` swap
 * (architecture/03-llm-adapter.md: one adapter for both). This is the ONLY
 * place the `openai` SDK is imported.
 */
import OpenAI from "openai";
import type { DraftRaw, DraftRequest, LLMConfig, LLMProvider } from "../types";

/**
 * Robustly extract a JSON object from a model's text. Reasoning models
 * (MiniMax-M2/M3, etc.) prepend `<think>...</think>` and may wrap JSON in
 * markdown fences. We strip those and take the outermost {...} span. Returns
 * the raw string on failure so schema validation surfaces it for a repair retry.
 */
export function parseModelJson(text: string): unknown {
  let s = text;
  // 1) drop chain-of-thought reasoning blocks.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // 2) drop a leading unterminated <think> (truncated / no closing tag).
  s = s.replace(/<think>[\s\S]*$/i, "");
  // 3) strip markdown code fences.
  s = s.replace(/```(?:json)?/gi, "");
  // 4) take the outermost object span.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  const candidate = start !== -1 && end > start ? s.slice(start, end + 1) : s.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return text; // let checkDraftPlan reject → repair retry with feedback
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly capabilities = {
    streaming: true,
    // MiniMax native JSON-Schema strictness is an open POC item; we request
    // json_object and rely on code validation + ≤2 repair retries regardless.
    jsonSchema: true,
  };

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly reasoningMode: "adaptive" | "disabled";
  private readonly maxCompletionTokens?: number;

  constructor(cfg: LLMConfig) {
    this.name = cfg.provider;
    this.model = cfg.model;
    this.reasoningMode = cfg.reasoningMode ?? "adaptive";
    this.maxCompletionTokens = cfg.maxCompletionTokens;
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
  }

  async generateDraft(req: DraftRequest): Promise<DraftRaw> {
    const userContent = req.repairFeedback
      ? `${req.userContext}\n\n<repair_feedback>\n이전 응답이 검증을 통과하지 못했다(스키마 또는 플랜 값 규칙). 아래 문제를 고쳐 DraftPlan JSON만 다시 출력하라(수치 금지):\n${req.repairFeedback}\n</repair_feedback>`
      : req.userContext;

    // MiniMax extends the OpenAI-compatible request with `thinking`. Keep the
    // vendor field inside this adapter and only send it to MiniMax M3; OpenAI
    // and older MiniMax models must not receive an unknown option (INV-4).
    const minimaxThinking =
      this.name === "minimax" && /^MiniMax-M3(?:$|-)/i.test(this.model) && this.reasoningMode === "disabled"
        ? { thinking: { type: "disabled" as const } }
        : {};
    const body = {
      model: this.model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      ...(this.maxCompletionTokens !== undefined
        ? { max_completion_tokens: this.maxCompletionTokens }
        : {}),
      ...minimaxThinking,
      messages: [
        { role: "system", content: req.systemPrefix },
        { role: "user", content: userContent },
      ],
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
      thinking?: { type: "disabled" };
    };
    const completion = await this.client.chat.completions.create(body);

    const text = completion.choices[0]?.message?.content ?? "";
    const draft = parseModelJson(text);

    return {
      draft,
      model: completion.model ?? this.model,
      usage: {
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        totalTokens: completion.usage?.total_tokens,
      },
      raw: completion,
    };
  }
}
