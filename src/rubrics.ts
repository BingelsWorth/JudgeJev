import type { V1Rubric } from "./contracts.js";

/**
 * Pluggable judging rubrics. This is the place to add, tweak, or retire a
 * rubric - none of this is part of the wire contract (see `V1Rubric` in
 * `contracts.ts`), so iterating here never touches request/response shapes.
 * Rubrics are versioned via their own `version` field, not their id.
 *
 * Jev picks which of these fits a request best (see `selectRubric` in
 * `jev-client.ts`) before candidate responses are even back, so add a rubric
 * here whenever an existing one doesn't fit a class of request well -
 * `description` is what Jev sees when choosing, so keep it specific enough
 * to distinguish rubrics from each other.
 */
export const RUBRICS: Record<string, V1Rubric> = {
  general: {
    id: "general",
    version: 1,
    description: "Default rubric for any text response that isn't better covered by a more specific rubric below.",
    instruction: "Compare the candidates and select the single best overall response to the request.",
    questions: [
      { id: "correctness", prompt: "Is the response accurate and does it correctly address what was asked?" },
      { id: "completeness", prompt: "Does the response cover everything the request needed, without missing key parts?" },
      { id: "clarity", prompt: "Is the response clear, well-organized, and easy to follow?" },
      { id: "safety", prompt: "Does the response avoid unsafe, misleading, or harmful content?" },
      { id: "helpfulness", prompt: "Does the response actually give the user what they need, without unnecessary padding?" },
    ],
  },
  coding: {
    id: "coding",
    version: 1,
    description: "For requests to write, fix, explain, or review code.",
    instruction: "Compare the candidates and select the single best overall answer to the coding request.",
    questions: [
      { id: "correctness", prompt: "Does the response correctly solve the requested coding task?" },
      { id: "completeness", prompt: "Does the response address all stated requirements and relevant edge cases?" },
      { id: "clarity", prompt: "Is the response clear, actionable, and easy to understand?" },
      { id: "safety", prompt: "Does the response avoid unsafe, misleading, or harmful guidance?" },
      { id: "efficiency", prompt: "Is the proposed approach appropriately efficient and maintainable?" },
    ],
  },
  math: {
    id: "math",
    version: 1,
    description: "For requests involving arithmetic, algebra, or step-by-step numerical/logical reasoning.",
    instruction: "Compare the candidates and select the single best overall answer to the math or reasoning request.",
    questions: [
      { id: "correctness", prompt: "Is the final answer numerically/logically correct?" },
      { id: "validity", prompt: "Is each step of the reasoning or calculation valid, with no unjustified leaps or errors?" },
      { id: "completeness", prompt: "Does the response solve the full problem, not just part of it?" },
      { id: "clarity", prompt: "Is the reasoning shown clearly enough to verify, not just a bare answer?" },
    ],
  },
  "tool-call": {
    id: "tool-call",
    version: 1,
    description: "For requests that should produce a function/tool call or other strictly structured output (e.g. JSON matching a schema).",
    instruction: "Compare the candidates and select the single best overall tool call or structured output for the request.",
    questions: [
      { id: "correctness", prompt: "Is the correct tool/function selected for the request?" },
      { id: "validity", prompt: "Is the output well-formed and does it strictly match the expected schema (correct field names and types)?" },
      { id: "completeness", prompt: "Are all required arguments/fields present and correctly populated?" },
      { id: "faithfulness", prompt: "Do the argument values accurately reflect what the request actually asked for, without invented or missing values?" },
    ],
  },
  translation: {
    id: "translation",
    version: 1,
    description: "For requests to translate text from one language to another.",
    instruction: "Compare the candidates and select the single best overall translation.",
    questions: [
      { id: "fidelity", prompt: "Does the translation preserve the original meaning without additions, omissions, or distortions?" },
      { id: "fluency", prompt: "Does the translation read naturally and fluently in the target language?" },
      { id: "tone", prompt: "Does the translation preserve the register and tone of the source (formal/informal, etc.)?" },
      { id: "completeness", prompt: "Is the entire source text translated, with nothing left untranslated or dropped?" },
    ],
  },
};

export const DEFAULT_RUBRIC_ID = "general";

export function getRubric(id: string | undefined): V1Rubric {
  if (id && RUBRICS[id]) return RUBRICS[id];
  return RUBRICS[DEFAULT_RUBRIC_ID];
}

export function listRubrics(): V1Rubric[] {
  return Object.values(RUBRICS);
}
