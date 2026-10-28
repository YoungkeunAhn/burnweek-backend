/**
 * 영어 운동명 → 한글 (D13). 사전 기반 조합이므로 같은 단어는 항상 같게 나온다.
 *
 *   "Barbell Incline Bench Press Medium Grip" → "바벨 인클라인 벤치프레스 미디엄 그립"
 *
 * 미번역 토큰은 대문자 `[?token]` 으로 남겨 테스트가 즉시 잡도록 한다 — 조용히
 * 영어를 흘리는 것보다 실패가 낫다.
 */
const { phrases, tokens, grammar } = require("./name-ko-glossary.cjs");
const labels = require("../src/data/exercise-labels.json");
const EXACT_NAMES = new Map(Object.values(labels).map(({ english, name_ko }) => [english, name_ko]));

// (tokenize는 아래에 함수 선언으로 호이스팅되므로 PHRASE_ENTRIES 초기화 시점에 사용 가능)

/**
 * 구문 키도 이름과 **같은 정규화**를 거쳐야 한다 — 그러지 않으면 `world's greatest`
 * 처럼 아포스트로피가 든 키는 영원히 매칭되지 않는다.
 * 긴 구문부터 매칭해야 "bench press"가 "bench"+"press"로 쪼개지지 않는다.
 */
const PHRASE_ENTRIES = Object.entries(phrases)
  .map(([key, value]) => ({ parts: tokenize(key), value }))
  .sort((a, b) => b.parts.length - a.parts.length);

/** `3/4 Sit-Up` → ['3/4', 'sit', 'up'] — fractions like 3/4 and 90/90 stay whole. */
function tokenize(name) {
  return name
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/(\d)\s*\/\s*(\d)/g, "$1⁄$2") // protect the fraction slash
    .split(/[^a-z0-9⁄]+/)
    .filter(Boolean)
    .map((t) => t.replace(/⁄/g, "/"));
}

function translateToken(token) {
  if (/^[\d/]+$/.test(token)) return token;
  if (token in grammar) return grammar[token];
  if (token in tokens) return tokens[token];
  return `[?${token}]`;
}

function nameKo(englishName) {
  // Curated whole names take precedence: token-level translation loses movement context.
  if (EXACT_NAMES.has(englishName)) return EXACT_NAMES.get(englishName);
  const words = tokenize(englishName);
  const out = [];

  let i = 0;
  outer: while (i < words.length) {
    for (const { parts, value } of PHRASE_ENTRIES) {
      if (parts.every((p, k) => words[i + k] === p)) {
        out.push(value);
        i += parts.length;
        continue outer;
      }
    }
    const piece = translateToken(words[i]);
    if (piece !== "") out.push(piece);
    i += 1;
  }

  return out
    .join(" ")
    .replace(/\s*\+\s*/g, " + ")
    .replace(/\s*·\s*/g, " · ")
    .replace(/\s+/g, " ")
    .replace(/^[+·/\s]+|[+·/\s]+$/g, "")
    .trim();
}

/** 사전에서 못 찾은 토큰 목록 — 커버리지 테스트용. */
function untranslated(englishName) {
  return [...nameKo(englishName).matchAll(/\[\?([a-z0-9]+)\]/g)].map((m) => m[1]);
}

module.exports = { nameKo, untranslated };
