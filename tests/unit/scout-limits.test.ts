import { describe, expect, it } from "vitest";
import { scoutMaxVets } from "../../apps/worker/src/index.js";

describe("scoutMaxVets", () => {
  it("checks 1 site unless a manual run asks for more, and never more than 6", () => {
    expect(scoutMaxVets({})).toBe(1);
    expect(scoutMaxVets({ A8_SCOUT_MAX_VETS: "" })).toBe(1);
    expect(scoutMaxVets({ A8_SCOUT_MAX_VETS: "4" })).toBe(4);
    expect(scoutMaxVets({ A8_SCOUT_MAX_VETS: "99" })).toBe(6);
    expect(scoutMaxVets({ A8_SCOUT_MAX_VETS: "0" })).toBe(1);
    expect(scoutMaxVets({ A8_SCOUT_MAX_VETS: "many" })).toBe(1);
  });
});
