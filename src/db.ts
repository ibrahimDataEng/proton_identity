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

	// code_hash, never the raw code — codes are short-lived, but there's no reason to
	// keep them recoverable at rest in case the DB is ever exposed. No UNIQUE/FK to
	// user_phones: a phone can be verifying ownership before any account exists for
	// it yet (see POST /otp/verify's userId:null case), and multiple outstanding
	// codes for the same phone are allowed (rate limits in otp.ts bound how many).
	await pool.query(`
		CREATE TABLE IF NOT EXISTS otp_codes (
			id SERIAL PRIMARY KEY,
			phone_e164 TEXT NOT NULL,
			code_hash TEXT NOT NULL,
			expires_at TIMESTAMPTZ NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			consumed BOOLEAN NOT NULL DEFAULT false,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`);
	await pool.query(`
		CREATE INDEX IF NOT EXISTS otp_codes_phone_e164_idx ON otp_codes (phone_e164)
	`);
}

export async function closeDb(): Promise<void> {
	await pool.end();
}
