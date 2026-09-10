import express, { type Request, type Response } from "express";
import { constantTimeEqual, requireServiceToken } from "./auth";
import { config } from "./config";
import { closeDb, ensureSchema, pool, UNIQUE_VIOLATION } from "./db";
import { describeError } from "./errors";
import {
	generateCode,
	hashCode,
	OTP_MAX_SENDS_PER_HOUR,
	OTP_MAX_VERIFY_ATTEMPTS,
	OTP_RESEND_COOLDOWN_SECONDS,
	OTP_TTL_SECONDS,
} from "./otp";
import { normalizePhone } from "./phone";
import { send as sendSms } from "./smsSender";

export const app = express();
app.use(express.json());

app.get("/health", async (_req: Request, res: Response) => {
	try {
		await pool.query("SELECT 1");
		return res.json({ status: "ok" });
	} catch (error) {
		return res.status(503).json({ status: "error", reason: describeError(error) });
	}
});

// Every route below this line requires Authorization: Bearer <SERVICE_TOKEN>.
app.use(requireServiceToken);

app.post("/phones", async (req: Request, res: Response) => {
	const userId: unknown = req.body?.userId;
	if (typeof userId !== "string" || userId.trim() === "") {
		return res.status(400).json({ error: "userId must be a non-empty string" });
	}

	const normalized = normalizePhone(req.body?.phone);
	if (!normalized.ok) {
		return res.status(400).json({ error: normalized.reason });
	}

	try {
		await pool.query(
			`INSERT INTO user_phones (user_id, phone_e164)
			 VALUES ($1, $2)
			 ON CONFLICT (user_id) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164`,
			[userId.trim(), normalized.e164],
		);
		return res.status(200).json({ phone: normalized.e164 });
	} catch (error) {
		// The UNIQUE constraint on phone_e164 means this specific code only fires when
		// the normalized number already belongs to a *different* user_id — the ON
		// CONFLICT clause above already handles the same-user re-submit case.
		const code = (error as { code?: unknown }).code;
		if (code === UNIQUE_VIOLATION) {
			return res.status(409).json({ error: "this phone is already registered to another account" });
		}
		console.error(`[phones] upsert failed: ${describeError(error)}`);
		return res.status(503).json({ error: "could not save phone" });
	}
});

app.get("/phones/status/:userId", async (req: Request, res: Response) => {
	const { userId } = req.params;
	try {
		const { rows } = await pool.query("SELECT 1 FROM user_phones WHERE user_id = $1", [userId]);
		return res.json({ hasPhone: rows.length > 0 });
	} catch (error) {
		console.error(`[phones/status] query failed: ${describeError(error)}`);
		return res.status(503).json({ error: "status unavailable" });
	}
});

app.get("/phones/lookup", async (req: Request, res: Response) => {
	const normalized = normalizePhone(req.query.phone);
	if (!normalized.ok) {
		return res.status(400).json({ error: normalized.reason });
	}

	try {
		const { rows } = await pool.query<{ user_id: string }>(
			"SELECT user_id FROM user_phones WHERE phone_e164 = $1",
			[normalized.e164],
		);
		if (rows.length === 0) {
			return res.status(404).json({ error: "no account found for this phone number" });
		}
		return res.json({ userId: rows[0].user_id });
	} catch (error) {
		console.error(`[phones/lookup] query failed: ${describeError(error)}`);
		return res.status(503).json({ error: "lookup unavailable" });
	}
});

app.post("/otp/send", async (req: Request, res: Response) => {
	const normalized = normalizePhone(req.body?.phone);
	if (!normalized.ok) {
		return res.status(400).json({ error: normalized.reason });
	}
	const phone = normalized.e164;

	try {
		// Resend cooldown: reject if the most recent still-valid code is too fresh.
		const { rows: recent } = await pool.query<{ created_at: Date }>(
			`SELECT created_at FROM otp_codes
			 WHERE phone_e164 = $1 AND consumed = false AND expires_at > now()
			 ORDER BY created_at DESC LIMIT 1`,
			[phone],
		);
		if (recent.length > 0) {
			const ageSeconds = (Date.now() - recent[0].created_at.getTime()) / 1000;
			if (ageSeconds < OTP_RESEND_COOLDOWN_SECONDS) {
				return res.status(429).json({ error: "resend_too_soon" });
			}
		}

		// Hourly cap: bounds SMS cost from abuse, independent of the cooldown above
		// (a user who waits out each cooldown could otherwise resend indefinitely).
		const { rows: hourly } = await pool.query<{ count: string }>(
			`SELECT COUNT(*) FROM otp_codes WHERE phone_e164 = $1 AND created_at > now() - interval '1 hour'`,
			[phone],
		);
		if (Number(hourly[0].count) >= OTP_MAX_SENDS_PER_HOUR) {
			return res.status(429).json({ error: "rate_limited" });
		}

		const code = generateCode();
		const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);
		await pool.query(
			`INSERT INTO otp_codes (phone_e164, code_hash, expires_at) VALUES ($1, $2, $3)`,
			[phone, hashCode(code), expiresAt],
		);

		await sendSms(phone, `Your Tawasi Plus verification code is ${code}. It expires in 5 minutes.`);

		return res.status(200).json({ sent: true, expiresInSeconds: OTP_TTL_SECONDS });
	} catch (error) {
		console.error(`[otp/send] failed: ${describeError(error)}`);
		return res.status(503).json({ error: "could not send code" });
	}
});

app.post("/otp/verify", async (req: Request, res: Response) => {
	const normalized = normalizePhone(req.body?.phone);
	if (!normalized.ok) {
		return res.status(400).json({ error: normalized.reason });
	}
	const phone = normalized.e164;

	const code: unknown = req.body?.code;
	if (typeof code !== "string" || code.trim() === "") {
		return res.status(400).json({ error: "code must be a non-empty string" });
	}

	try {
		const { rows } = await pool.query<{
			id: number;
			code_hash: string;
			expires_at: Date;
			attempts: number;
		}>(
			`SELECT id, code_hash, expires_at, attempts FROM otp_codes
			 WHERE phone_e164 = $1 AND consumed = false
			 ORDER BY created_at DESC LIMIT 1`,
			[phone],
		);

		const record = rows[0];
		if (!record || record.expires_at.getTime() < Date.now()) {
			return res.status(400).json({ error: "expired_or_not_found" });
		}

		// Checked, and refused, BEFORE touching the hash — a code that's already hit
		// the attempt cap must never be compared again, correct guess or not.
		if (record.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
			return res.status(429).json({ error: "too_many_attempts" });
		}

		if (!constantTimeEqual(hashCode(code.trim()), record.code_hash)) {
			const { rows: updated } = await pool.query<{ attempts: number }>(
				`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
				[record.id],
			);
			const attemptsRemaining = Math.max(0, OTP_MAX_VERIFY_ATTEMPTS - updated[0].attempts);
			return res.status(400).json({ error: "invalid_code", attemptsRemaining });
		}

		// Single-use: consumed flips immediately on the correct guess, so replaying
		// the same correct code again can never verify a second time.
		await pool.query(`UPDATE otp_codes SET consumed = true WHERE id = $1`, [record.id]);

		const { rows: userRows } = await pool.query<{ user_id: string }>(
			`SELECT user_id FROM user_phones WHERE phone_e164 = $1`,
			[phone],
		);

		// userId:null is a real, valid outcome (ownership verified, no account linked
		// yet) — not an error. The caller (a future Saleor plugin) decides what to do
		// with it; this service's job is only to report the facts accurately.
		return res.status(200).json({ verified: true, userId: userRows[0]?.user_id ?? null });
	} catch (error) {
		console.error(`[otp/verify] failed: ${describeError(error)}`);
		return res.status(503).json({ error: "verification unavailable" });
	}
});

async function main(): Promise<void> {
	if (!config.serviceToken) {
		console.warn(
			"[startup] SERVICE_TOKEN is not set — every protected request will be rejected with 503 until it is configured. See .env.example.",
		);
	}

	await ensureSchema();
	console.log("[startup] schema ready");

	const server = app.listen(config.port, () => {
		console.log(`[startup] listening on port ${config.port}`);
	});

	const shutdown = async (signal: string): Promise<void> => {
		console.log(`[shutdown] received ${signal}, closing`);
		server.close();
		await closeDb();
		process.exit(0);
	};

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (require.main === module) {
	main().catch((error: unknown) => {
		console.error("[startup] failed:", error);
		process.exit(1);
	});
}
