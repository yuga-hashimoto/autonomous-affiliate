import { describe } from "vitest";
import { Pool } from "pg";
import { createPgRepository, runMigrations, type Repository } from "@aff/db";
import { repositoryContract } from "./contract.js";

// Only a database set aside for tests: every table is emptied before each test, so this must never
// fall back to DATABASE_URL (which can be the live database).
const databaseUrl = process.env.TEST_DATABASE_URL;

let pool: Pool | undefined;

/** Each test starts from an empty database, as the in-memory repository does. */
async function makeRepo(): Promise<Repository> {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL not set");
  pool ??= new Pool({ connectionString: databaseUrl });
  await runMigrations(pool);
  const tables = (
    await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")
  ).rows.map((row) => `"${row.tablename}"`);
  if (tables.length > 0) await pool.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
  return createPgRepository(pool);
}

repositoryContract("postgres", makeRepo, databaseUrl ? describe : describe.skip);
