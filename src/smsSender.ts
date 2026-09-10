/**
 * Sends an SMS message. This is currently the ONLY implementation — a dev-only stub
 * that logs the message instead of sending it, because no SMS provider account
 * exists yet (see README's "Future SMS integration point"). It never fails, so
 * `send()`'s callers can still exercise the full success path locally.
 *
 * Wiring a real provider later is a single-file change: replace the body below with
 * a real API call (Twilio, etc.) that resolves on success and rejects/throws on
 * delivery failure. `send`'s signature — `(phone: string, message: string) =>
 * Promise<void>` — is the only contract callers depend on; do not change it without
 * updating them.
 */
export async function send(phone: string, message: string): Promise<void> {
	// Deliberately loud and unambiguous — this is the only way to read an OTP code
	// locally until a real provider is wired in.
	console.log(`[DEV SMS] Would send to ${phone}: ${message}`);
}
