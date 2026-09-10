import { Pool } from "pg";
import { config } from "./config";
import { describeError } from "./errors";

/** Single shared pool for the whole process — never create a client per request. */
export const pool = new Pool({
	connectionString: config.databaseUrl,
	max: 10,
	idleTimeoutMillis: 30_000,
});

pool.on("error", (err: Error) => {
	console.error(`[db] idle client error: ${describeError(err)}`);
});

/** Postgres error code for a UNIQUE constraint violation. */
export const UNIQUE_VIOLATION = "23505";

/**
 * Creates this service's only table. Deliberately uniquely named so it cannot collide
 * with any Saleor table sharing the same database. Idempotent — safe to run every boot.
 *
 * The UNIQUE constraint on phone_e164 enforces "one phone per account, one account per
 * phone" at the database level, not just in application logic — the /phones handler
 * relies on this to detect the 409-conflict case atomically.
 */
export async function ensureSchema(): Promise<void> {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS user_phones (
			user_id TEXT PRIMARY KEY,
			phone_e164 TEXT NOT NULL UNIQUE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`);
}

export async function closeDb(): Promise<void> {
	await pool.end();
}
