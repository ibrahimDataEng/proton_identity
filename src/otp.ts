import { createHash, randomInt } from "crypto";

/** How long an issued code stays valid. */
export const OTP_TTL_SECONDS = 300;

/** Minimum time between two sends to the same phone — prevents spam-resend. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** Max codes a single phone may request within a rolling hour — bounds SMS cost from abuse. */
export const OTP_MAX_SENDS_PER_HOUR = 5;

/** Max wrong-code guesses allowed against a single issued code before it locks out. */
export const OTP_MAX_VERIFY_ATTEMPTS = 5;

/**
 * A 6-digit numeric code, cryptographically random (never Math.random — this is an
 * auth credential). Upper bound is 1_000_000, not 999_999: crypto.randomInt(min, max)
 * treats max as EXCLUSIVE, so 999_999 here would silently drop "999999" from the
 * possible code space.
 */
export function generateCode(): string {
	return String(randomInt(100_000, 1_000_000));
}

/** Codes are short-lived but still hashed at rest, never stored raw, in case the DB is ever exposed. */
export function hashCode(code: string): string {
	return createHash("sha256").update(code).digest("hex");
}
