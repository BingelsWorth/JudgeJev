import type { V1Rubric } from "./contracts.js";

/**
 * Pluggable judging rubrics. This is the place to add, tweak, or retire a
 * rubric - none of this is part of the wire contract (see `V1Rubric` in
 * `contracts.ts`), so iterating here never touches request/response shapes.
 *
 * Jev picks which of these fits a request best (see `selectRubric` in
 * `jev-client.ts`) before candidate responses are even back, so add a rubric
 * here whenever an existing one doesn't fit a class of request well -
 * `description` is what Jev sees when choosing, so keep it specific enough
 * to distinguish rubrics from each other.
 */
export const RUBRICS: Record<string, V1Rubric> = {
  "general-v1": {
    id: "general-v1",
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
  "coding-v1": {
    id: "coding-v1",
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
};

export const DEFAULT_RUBRIC_ID = "general-v1";

export function getRubric(id: string | undefined): V1Rubric {
  if (id && RUBRICS[id]) return RUBRICS[id];
  return RUBRICS[DEFAULT_RUBRIC_ID];
}

export function listRubrics(): V1Rubric[] {
  return Object.values(RUBRICS);
}
