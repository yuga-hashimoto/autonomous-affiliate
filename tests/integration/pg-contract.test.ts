import { describe } from "vitest";
import { Pool } from "pg";
import { createPgRepository, runMigrations, type Repository } from "@aff/db";
import { repositoryContract } from "./contract.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let pool: Pool | undefined;

async function makeRepo(): Promise<Repository> {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL/DATABASE_URL not set");
  pool ??= new Pool({ connectionString: databaseUrl });
  await runMigrations(pool);
  return createPgRepository(pool);
}

repositoryContract("postgres", makeRepo, databaseUrl ? describe : describe.skip);
