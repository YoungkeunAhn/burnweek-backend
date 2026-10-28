/**
 * 자유 텍스트 출력 경계 (백로그 008 §1, ADR-0016).
 * 사용자에게 보이는 이름·focus는 이제 전부 코드가 만들므로 새 LLM draft에
 * 번역할 자유 텍스트 자체를 받지 않는다.
 */
import { describe, expect, it } from "vitest";
import { buildSystemPrefix, compactDraftSchema } from "../src/generation/prompt";
import draftPlanSchema from "../src/schemas/draft-plan.schema.json";

describe("프롬프트", () => {
  it("모델이 사용자 노출 자유 텍스트를 만들지 않는다", () => {
    const prefix = buildSystemPrefix(compactDraftSchema(draftPlanSchema as Record<string, unknown>));
    expect(prefix).toContain("focus는 반드시 빈 문자열");
    expect(prefix).toContain("name·coaching_cue·substitution_options·cardio_kind는 출력하지 마라");
  });
});
