import { describe, expect, it } from "vitest";
import { DEFAULT_RUBRIC_ID, RUBRICS, getRubric, listRubrics } from "../src/rubrics.js";

describe("rubrics", () => {
  it("exposes the default general-purpose rubric", () => {
    const rubric = RUBRICS[DEFAULT_RUBRIC_ID];
    expect(rubric.id).toBe("general-v1");
    expect(rubric.description).toBeTruthy();
    expect(rubric.questions.length).toBeGreaterThan(0);
  });

  it("exposes a coding-specific rubric distinct from the default", () => {
    const rubric = RUBRICS["coding-v1"];
    expect(rubric.id).toBe("coding-v1");
    expect(rubric.id).not.toBe(DEFAULT_RUBRIC_ID);
    expect(rubric.description).toBeTruthy();
  });

  it("every rubric has a non-empty id, description, instruction, and at least one question", () => {
    for (const rubric of listRubrics()) {
      expect(rubric.id.trim()).not.toBe("");
      expect(rubric.description.trim()).not.toBe("");
      expect(rubric.instruction.trim()).not.toBe("");
      expect(rubric.questions.length).toBeGreaterThan(0);
      for (const question of rubric.questions) {
        expect(question.id.trim()).not.toBe("");
        expect(question.prompt.trim()).not.toBe("");
      }
    }
  });

  describe("getRubric", () => {
    it("returns the requested rubric by id", () => {
      expect(getRubric("coding-v1").id).toBe("coding-v1");
    });

    it("falls back to the default rubric for an unknown id", () => {
      expect(getRubric("not-a-real-rubric").id).toBe(DEFAULT_RUBRIC_ID);
    });

    it("falls back to the default rubric when no id is given", () => {
      expect(getRubric(undefined).id).toBe(DEFAULT_RUBRIC_ID);
    });
  });

  describe("listRubrics", () => {
    it("returns every registered rubric", () => {
      expect(listRubrics().map((r) => r.id).sort()).toEqual(Object.keys(RUBRICS).sort());
    });
  });
});
