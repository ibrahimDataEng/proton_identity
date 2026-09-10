import express, { type Request, type Response } from "express";
import { requireServiceToken } from "./auth";
import { config } from "./config";
import { closeDb, ensureSchema, pool, UNIQUE_VIOLATION } from "./db";
import { describeError } from "./errors";
import { normalizePhone } from "./phone";

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
