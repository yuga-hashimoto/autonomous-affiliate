import { Pool } from "pg";
import { createPgRepository } from "./pg/pg-repository.js";
import type { Repository } from "./repository.js";

export type {
  Repository,
  JobRunRepository,
  LockRepository,
  ContentRepository,
  SourceRepository,
  FactRepository,
  AnalysisRepository,
  OfferRepository,
  MetricsRepository,
  SpendRepository,
  AuditRepository,
  SerpRepository,
  AgentEventRecord,
  AnalysisRecord,
  ContentTransitionRecord,
} from "./repository.js";
export type { JobRunRecord, JobRunEnqueueInput } from "./records.js";
export { runMigrations } from "./pg/migrate.js";
export { createPgRepository } from "./pg/pg-repository.js";
export { createMemoryRepository } from "./memory-repository.js";

export function createRepositoryFromEnv(env: NodeJS.ProcessEnv = process.env): Repository {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    // Fail closed: without a configured database the platform runs stateless dry-run only.
    throw new Error("DATABASE_URL is not configured; use createMemoryRepository() for dry-run");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  return createPgRepository(pool);
}
