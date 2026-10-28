import { disassemble, getChoseong } from "es-hangul";
import labels from "./exercise-labels.json";

const SEARCH_ALIASES = new Map(Object.entries(labels).map(([id, entry]) => [id, entry.aliases]));

/** 카탈로그의 영문 약어와 한글 발음을 같은 검색어로 취급한다. 종목 ID는 유지한다. */
function aliases(value: string): string {
  return value.normalize("NFC").toLowerCase()
    .replace(/이지[\s_-]*바(?:[_-]*바벨)?/g, "이지바")
    .replace(/(^|[^a-z])e[\s_-]*z[\s_-]*(?:bar|바)(?:[_-]*바벨)?/g, "$1이지바")
    .replace(/티[\s_-]*바/g, "티바").replace(/(^|[^a-z])t[\s_-]*(?:bar|바)/g, "$1티바")
    .replace(/브이[\s_-]*바/g, "브이바").replace(/(^|[^a-z])v[\s_-]*(?:bar|바)/g, "$1브이바")
    .replace(/제이[\s_-]*엠/g, "제이엠").replace(/(^|[^a-z])j[\s_-]*m(?=$|[^a-z])/g, "$1제이엠")
    .replace(/에스[\s_-]*엠[\s_-]*알/g, "에스엠알").replace(/(^|[^a-z])s[\s_-]*m[\s_-]*r(?=$|[^a-z])/g, "$1에스엠알");
}

const compact = (value: string) => value.replace(/[\s_-]+/g, "");

/** 기존 OR 검색을 유지한다. 질의를 한 번 분해하고 이름·영문명·ID에 같은 판정을 쓴다. */
export function createExerciseMatcher(query: string): (names: readonly string[]) => boolean {
  const terms = aliases(query).split(/\s+/).map(compact).filter(Boolean).map((text) => ({
    text, jamo: disassemble(text), choseong: /^[ㄱ-ㅎ]+$/.test(text),
  }));
  // Callers include the stable exercise ID. Only aliases for that exact ID are added.
  return (names) => terms.length === 0 ? !query.trim() : names.flatMap((name) =>
    [name, ...(SEARCH_ALIASES.get(name) ?? [])]).some((name) =>
    // 원문도 유지해야 `EZ`·`J`처럼 영문 약어를 입력하는 중에도 찾을 수 있다.
    [compact(name.normalize("NFC").toLowerCase()), compact(aliases(name))].some((text) =>
      terms.some((term) => text.includes(term.text)
        || (term.choseong ? getChoseong(text).includes(term.text) : disassemble(text).includes(term.jamo)))));
}
