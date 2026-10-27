import { describe, expect, it } from "vitest";
import type { Repository } from "@aff/db";
import { newTraceId, sha256Hex } from "@aff/domain";

/**
 * Contract tests shared by the in-memory repository (always) and the Postgres
 * repository (when DATABASE_URL is provided). docs/11 B003.
 */
export function repositoryContract(
  name: string,
  makeRepo: () => Promise<Repository> | Repository,
  describeImpl: (name: string, fn: () => void) => void = describe,
) {
  describeImpl(`repository contract: ${name}`, () => {
    it("B003: re-enqueueing the same job_key does not create a second job run", async () => {
      const repo = await makeRepo();
      const traceId = newTraceId();
      const first = await repo.jobs.enqueue({
        jobKey: "research|opp-1|v1|policy-v1",
        jobType: "research",
        traceId,
      });
      expect(first.created).toBe(true);
      const second = await repo.jobs.enqueue({
        jobKey: "research|opp-1|v1|policy-v1",
        jobType: "research",
        traceId: newTraceId(),
      });
      expect(second.created).toBe(false);
      expect(second.record.id).toBe(first.record.id);
      expect((await repo.jobs.countByState()).PENDING).toBe(1);
    });

    it("validates job state transitions", async () => {
      const repo = await makeRepo();
      const { record } = await repo.jobs.enqueue({
        jobKey: "k1",
        jobType: "t",
        traceId: newTraceId(),
      });
      const running = await repo.jobs.update({ ...record, state: "RUNNING" });
      expect(running.state).toBe("RUNNING");
      const done = await repo.jobs.update({ ...running, state: "SUCCEEDED" });
      expect(done.state).toBe("SUCCEEDED");
      await expect(repo.jobs.update({ ...done, state: "RUNNING" })).rejects.toThrow();
    });

    it("listReady only returns due jobs", async () => {
      const repo = await makeRepo();
      const future = new Date(Date.now() + 60_000).toISOString();
      await repo.jobs.enqueue({ jobKey: "due", jobType: "t", traceId: newTraceId() });
      await repo.jobs.enqueue({ jobKey: "later", jobType: "t", traceId: newTraceId(), runAfter: future });
      const ready = await repo.jobs.listReady(new Date().toISOString(), 10);
      expect(ready.map((r) => r.jobKey)).toEqual(["due"]);
    });

    it("concurrency lock: second holder cannot acquire, owner can release", async () => {
      const repo = await makeRepo();
      const acquired = await repo.locks.tryAcquire("publish-daily", "run-a", 60);
      expect(acquired).toBe(true);
      const stolen = await repo.locks.tryAcquire("publish-daily", "run-b", 60);
      expect(stolen).toBe(false);
      const released = await repo.locks.release("publish-daily", "run-a");
      expect(released).toBe(true);
      const reacquired = await repo.locks.tryAcquire("publish-daily", "run-b", 60);
      expect(reacquired).toBe(true);
    });

    it("content: slug+locale uniqueness, revisions, qa reports, transitions", async () => {
      const repo = await makeRepo();
      const a = await repo.content.createIfNotExists({ slug: "sim-20gb", locale: "ja-JP", topic: "mobile" });
      const b = await repo.content.createIfNotExists({ slug: "sim-20gb", locale: "ja-JP", topic: "mobile" });
      expect(a.id).toBe(b.id);
      await repo.content.updateState(a.id, "DISCOVERED");
      const rev = await repo.content.saveRevision({
        id: "rev_1",
        itemId: a.id,
        contentHash: sha256Hex("body"),
        markdownPath: "content/sim-20gb.md",
        sourceIds: ["src_1"],
      });
      await repo.content.setCurrentRevision(a.id, rev.id);
      const item = await repo.content.getBySlug("sim-20gb", "ja-JP");
      expect(item?.currentRevision).toBe("rev_1");
      expect((await repo.content.getLatestRevision(a.id))?.id).toBe("rev_1");
      await repo.content.recordTransition({
        itemId: a.id,
        runId: "run-1",
        fromState: null,
        toState: "DISCOVERED",
        policyVersion: "v1",
        evidenceIds: [],
        at: new Date().toISOString(),
      });
      expect(await repo.content.listTransitions(a.id)).toHaveLength(1);
    });

    it("offers: conversion import dedupes on (program_id, external_event_id)", async () => {
      const repo = await makeRepo();
      await repo.offers.upsertProgram({
        id: "prog-1",
        provider: "a8",
        status: "APPROVED",
        payoutCurrency: "JPY",
      });
      const offer = await repo.offers.upsertOffer({
        id: "offer-1",
        programId: "prog-1",
        verticalId: "mobile",
        title: "SIM A",
        rewardModel: "fixed_jpy",
        rewardAmountJpy: 3000,
        channelPermissions: ["site"],
        active: true,
        status: "APPROVED",
        constraints: {},
      });
      expect(offer.status).toBe("APPROVED");
      const conv = {
        id: "c1",
        programId: "prog-1",
        externalEventId: "evt-9",
        offerId: "offer-1",
        occurredAt: new Date().toISOString(),
        status: "PENDING" as const,
        amount: 3000,
        currency: "JPY",
      };
      const first = await repo.offers.importConversion(conv);
      const second = await repo.offers.importConversion({ ...conv, id: "c1-dup" });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect((await repo.offers.listConversions()).length).toBe(1);
      expect((await repo.offers.listApprovedActiveOffers()).map((o) => o.id)).toEqual(["offer-1"]);
    });

    it("spend accumulates per day+category+provider+source and sums by month", async () => {
      const repo = await makeRepo();
      await repo.spend.recordSpend({
        date: "2026-10-24",
        category: "llm",
        provider: "mock",
        costJpy: 30,
        source: "job-1",
        estimated: true,
      });
      await repo.spend.recordSpend({
        date: "2026-10-24",
        category: "llm",
        provider: "mock",
        costJpy: 12,
        source: "job-1",
        estimated: true,
      });
      expect(await repo.spend.sumMonth("2026-10")).toBe(42);
      expect(await repo.spend.sumMonth("2026-11")).toBe(0);
    });

    it("metrics: upsert overwrites same key; missing values stay UNKNOWN", async () => {
      const repo = await makeRepo();
      await repo.metrics.upsertTrafficDaily({
        date: "2026-10-23",
        pageId: "p1",
        channel: "search",
        sessions: 100,
        searchClicks: 10,
        impressions: "UNKNOWN",
      });
      await repo.metrics.upsertTrafficDaily({
        date: "2026-10-23",
        pageId: "p1",
        channel: "search",
        sessions: 150,
        searchClicks: 12,
        impressions: "UNKNOWN",
      });
      const rows = await repo.metrics.listTraffic();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sessions).toBe(150);
      expect(rows[0]!.impressions).toBe("UNKNOWN");
    });

    it("publications: countOnDay counts articles first published that day, not later revisions", async () => {
      const repo = await makeRepo();
      const publication = (id: string, itemId: string, revisionId: string, publishedAt: string, extra = {}) => ({
        id,
        itemId,
        revisionId,
        destination: "git" as const,
        status: "SUCCEEDED" as const,
        publishedAt,
        ...extra,
      });
      // article A: first published on day 1, replaced by an update on day 2
      await repo.publications.save(publication("pub_a1", "item_a", "rev_a1", "2026-10-27T04:00:00.000Z"));
      await repo.publications.save(publication("pub_a2", "item_a", "rev_a2", "2026-10-28T04:00:00.000Z"));
      expect(await repo.publications.countOnDay("2026-10-27")).toBe(1);
      expect(await repo.publications.countOnDay("2026-10-28")).toBe(0);

      // article B is new on day 2, so it is the day's one new article
      await repo.publications.save(publication("pub_b1", "item_b", "rev_b1", "2026-10-28T05:00:00.000Z"));
      expect(await repo.publications.countOnDay("2026-10-28")).toBe(1);

      // previews, failed builds and a second destination of the same article do not count
      await repo.publications.save(
        publication("pub_c1", "item_c", "rev_c1", "2026-10-28T06:00:00.000Z", { destination: "preview" as const }),
      );
      await repo.publications.save(
        publication("pub_d1", "item_d", "rev_d1", "2026-10-28T06:30:00.000Z", { status: "FAILED" as const }),
      );
      await repo.publications.save(
        publication("pub_b2", "item_b", "rev_b1", "2026-10-28T07:00:00.000Z", { destination: "pages" as const }),
      );
      expect(await repo.publications.countOnDay("2026-10-28")).toBe(1);
    });
  });
}
