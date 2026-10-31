import { describe, expect, it } from "vitest";
import { scoutMaxVets } from "../../apps/worker/src/index.js";

describe("scoutMaxVets", () => {
  it("checks 2 sites unless a manual run asks for more, and never more than 6", () => {
    expect(scoutMaxVets({})).toBe(2);
    expect(scoutMaxVets({ A8_SCOUT_MAX_VETS: "" })).toBe(2);
    expect(scoutMaxVets({ A8_SCOUT_MAX_VETS: "4" })).toBe(4);
    expect(scoutMaxVets({ A8_SCOUT_MAX_VETS: "99" })).toBe(6);
    expect(scoutMaxVets({ A8_SCOUT_MAX_VETS: "0" })).toBe(2);
    expect(scoutMaxVets({ A8_SCOUT_MAX_VETS: "many" })).toBe(2);
  });
});
