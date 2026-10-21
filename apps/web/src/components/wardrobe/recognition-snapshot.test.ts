import { reactive } from "vue";
import { describe, expect, it } from "vitest";
import { snapshotRecognitionFields } from "./recognition-snapshot";

describe("snapshotRecognitionFields", () => {
  it("copies recognition fields from a Vue reactive form", () => {
    const form = reactive({
      name: "",
      category: "TOP",
      color: "",
      stylingAdvice: "",
      seasons: ["SPRING"],
      layers: [],
      scenes: [],
    });

    const before = snapshotRecognitionFields(form);
    form.seasons.push("AUTUMN");

    expect(before.seasons).toEqual(["SPRING"]);
    expect(before.name).toBe("");
  });
});
