import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

function resolveMigrationsDir(): string {
  if (process.env.DB_MIGRATIONS_DIR) return resolve(process.env.DB_MIGRATIONS_DIR);
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "../migrations"),
    // The worker is bundled to apps/worker/dist; its cwd remains repo root.
    resolve(process.cwd(), "packages/db/src/migrations"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`database migrations directory not found; tried: ${candidates.join(", ")}`);
  }
  return found;
}

export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const migrationsDir = resolveMigrationsDir();
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const appliedNow: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        appliedNow.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${String(error)}`);
      }
    }
    return appliedNow;
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
