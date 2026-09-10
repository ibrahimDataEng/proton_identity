import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";

/**
 * Constant-time string compare. Originally just for the bearer-token check below,
 * now also reused by otp.ts for code-hash comparison — this service exists
 * specifically to guard PII/auth secrets, so unlike a typical string `===` check,
 * neither comparison should leak how many leading bytes matched via response timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	// timingSafeEqual throws on length mismatch rather than returning false, so the
	// length check must happen first. This leaks length via timing, not content — an
	// accepted, standard tradeoff (and moot for otp.ts's use, where both sides are
	// always a fixed-length SHA-256 hex digest).
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/** Applied to every route except /health — see server.ts route ordering. */
export function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
	if (!config.serviceToken) {
		res.status(503).json({ error: "service not configured" });
		return;
	}

	const header = req.header("Authorization") ?? "";
	const [scheme, token] = header.split(" ");

	if (scheme !== "Bearer" || !token || !constantTimeEqual(token, config.serviceToken)) {
		res.status(401).json({ error: "unauthorized" });
		return;
	}

	next();
}
