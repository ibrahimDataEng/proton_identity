import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";

/**
 * Constant-time token compare. This service exists specifically to guard PII
 * (phone numbers), so unlike a typical string `===` check, the comparison must not
 * leak how many leading bytes matched via response timing.
 */
function tokensMatch(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	// timingSafeEqual throws on length mismatch rather than returning false, so the
	// length check must happen first. This leaks token *length* via timing, not
	// content — an accepted, standard tradeoff for a bearer-token compare.
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

	if (scheme !== "Bearer" || !token || !tokensMatch(token, config.serviceToken)) {
		res.status(401).json({ error: "unauthorized" });
		return;
	}

	next();
}
