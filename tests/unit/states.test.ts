import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  canTransitionJob,
  type ContentState,
} from "@aff/domain";

describe("content pipeline state machine (docs/04)", () => {
  it("allows the happy path", () => {
    const happy: ContentState[] = [
      "DISCOVERED",
      "ELIGIBILITY_CHECKED",
      "RESEARCHED",
      "ANALYZED",
      "DRAFTED",
      "QA_PENDING",
      "APPROVED_AUTOMATICALLY",
      "DEPLOYING",
      "PUBLISHED",
      "MEASURING",
      "UPDATE_CANDIDATE",
      "RESEARCHED",
    ];
    for (let i = 0; i < happy.length - 1; i++) {
      expect(canTransition(happy[i]!, happy[i + 1]!), `${happy[i]}->${happy[i + 1]}`).toBe(true);
    }
  });

  it("blocks direct publish from discovered", () => {
    expect(canTransition("DISCOVERED", "PUBLISHED")).toBe(false);
    expect(canTransition("DRAFTED", "PUBLISHED")).toBe(false);
  });

  it("allows quarantine from every pre-publish stage", () => {
    for (const s of [
      "DISCOVERED",
      "ELIGIBILITY_CHECKED",
      "RESEARCHED",
      "ANALYZED",
      "DRAFTED",
      "QA_PENDING",
    ] as const) {
      expect(canTransition(s, "QUARANTINED")).toBe(true);
    }
  });

  it("allows QA repair loop and revocation of published content", () => {
    expect(canTransition("QA_PENDING", "DRAFTED")).toBe(true);
    expect(canTransition("QA_PENDING", "REJECTED")).toBe(true);
    expect(canTransition("QA_PENDING", "STOPPED_BUDGET")).toBe(true);
    expect(canTransition("PUBLISHED", "REVOKED")).toBe(true);
    expect(canTransition("REVOKED", "RESEARCHED")).toBe(true);
  });

  it("throws InvalidTransitionError on illegal moves", () => {
    expect(() => assertTransition("REJECTED", "PUBLISHED")).toThrow(InvalidTransitionError);
  });
});

describe("job run state machine", () => {
  it("supports retry and dead letter", () => {
    expect(canTransitionJob("PENDING", "RUNNING")).toBe(true);
    expect(canTransitionJob("RUNNING", "RETRY_SCHEDULED")).toBe(true);
    expect(canTransitionJob("RETRY_SCHEDULED", "RUNNING")).toBe(true);
    expect(canTransitionJob("RUNNING", "DEAD_LETTER")).toBe(true);
    expect(canTransitionJob("SUCCEEDED", "RUNNING")).toBe(false);
    expect(canTransitionJob("DEAD_LETTER", "RUNNING")).toBe(false);
  });
});
