import { parsePhoneNumberFromString } from "libphonenumber-js";
import { DEFAULT_PHONE_REGION } from "./config";

export type PhoneNormalizationResult = { ok: true; e164: string } | { ok: false; reason: string };

/**
 * Normalizes a phone number to E.164. A number given without a leading "+" is assumed
 * to be in DEFAULT_PHONE_REGION (UAE, this project's primary market) — e.g. a local
 * "050 123 4567" resolves the same as "+971501234567". A number that already includes
 * a country code (with or without "+") is parsed on its own terms, region hint or not.
 */
export function normalizePhone(raw: unknown): PhoneNormalizationResult {
	if (typeof raw !== "string" || raw.trim() === "") {
		return { ok: false, reason: "phone must be a non-empty string" };
	}

	const parsed = parsePhoneNumberFromString(raw.trim(), DEFAULT_PHONE_REGION);
	if (!parsed || !parsed.isValid()) {
		return { ok: false, reason: "phone is not a valid phone number" };
	}

	return { ok: true, e164: parsed.number };
}
