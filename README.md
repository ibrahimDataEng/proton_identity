# proton_identity

Standalone phone-number-to-Saleor-user-id lookup service.

Maps a verified phone number to a Saleor user id, in a small, uniquely-named
Postgres table with a real `UNIQUE` index on the phone column. Built as the
foundation for two features that aren't implemented yet:

1. **Enforcing "phone required" via a login-gate** — the storefront can check
   `GET /phones/status/:userId` after login/registration and force the user to
   supply a phone before continuing, closing the gap where `accountRegister`
   itself has no phone field and can't atomically enforce one (see
   `proton_storefront`'s registration-flow diagnostic for why).
2. **OTP-based passwordless login** — `POST /otp/send` + `POST /otp/verify`
   (below) issue and check one-time codes against the phone table. Saleor's
   plugin system was confirmed (separate research session) to provide **zero**
   built-in protection for an external-auth flow like this — no rate limiting,
   no replay protection — so every safeguard here is this service's own. A
   Saleor plugin calling `POST /otp/verify` to mint a real session token is a
   **separate, not-yet-built** piece — this service only proves phone
   ownership and reports the linked `userId` (or `null`); it has no concept of
   a Saleor session itself.

## Design constraints

This service is **fully independent** of `proton_storefront` and
`proton_platform` (Saleor), mirroring the `proton_analytics` precedent:

- It does **not** modify the Saleor image, Dockerfile, `settings.py`, or
  `urls.py`.
- It has zero coupling to Saleor's codebase or deployment lifecycle.
- It owns two uniquely named Postgres tables, `user_phones` and `otp_codes`,
  in the same `saleor` database. Both names were checked against existing
  tables — no collision.
- Unlike `proton_analytics` and `proton_payments`, this service handles PII
  (phone numbers) and is **not** left open on the internal network — every
  route except `/health` requires a bearer service token (see "Auth" below).

## Environment variables

| Variable       | Local dev                                                    | In Docker (shared network)                  |
| -------------- | ------------------------------------------------------------- | -------------------------------------------- |
| `PORT`         | `5001`                                                         | `5001`                                       |
| `DATABASE_URL` | `postgres://saleor:saleor@localhost:5432/saleor`               | `postgres://saleor:saleor@db:5432/saleor`    |
| `SERVICE_TOKEN`| a real random value, e.g. `openssl rand -hex 32`               | same, injected via compose/secrets           |

Copy `.env.example` to `.env` to get started. Postgres credentials match
`saleor_platform/backend.env`.

### ⚠️ Local Postgres port conflict on this Windows machine

Same issue documented in `proton_analytics`'s README: `localhost:5432` does
**not** reach the Saleor Postgres container here — a native Windows service
(`PostgreSQL_For_Odoo`, PostgreSQL 12) binds `0.0.0.0:5432` and wins over
Docker's port proxy, failing with `password authentication failed for user
"saleor"`. Work around it the same way, without touching `saleor_platform`:

```bash
docker run --rm -d --name pi-pgforward \
  --network saleor_platform_saleor-backend-tier -p 15432:5432 \
  alpine/socat tcp-listen:5432,fork,reuseaddr tcp-connect:db:5432
```

Then set `DATABASE_URL=postgres://saleor:saleor@localhost:15432/saleor` in
`.env`. In Docker the service reaches Postgres directly at `db:5432`, no
forwarder needed.

## Auth

Every route except `/health` requires:

```
Authorization: Bearer <SERVICE_TOKEN>
```

- Missing or wrong token → `401 { "error": "unauthorized" }`.
- `SERVICE_TOKEN` unset entirely → `503 { "error": "service not configured" }`
  (fails closed rather than open — mirrors `proton_payments`'s unset-secret
  behavior). A startup warning is logged in this case.
- The comparison is constant-time (`crypto.timingSafeEqual`) since this
  service exists specifically to guard PII.

`/health` is intentionally unauthenticated so it can be used as a plain
Docker healthcheck without also provisioning the token there.

This service is still internal-network only — `SERVICE_TOKEN` prevents
*other containers* on the shared network from reading/writing phone data
casually, it does not make the service safe to expose publicly.

## SMS delivery — not wired yet

`src/smsSender.ts` exports one function:

```ts
export async function send(phone: string, message: string): Promise<void>
```

Its only implementation right now is a **dev-only stub** that logs the
message instead of sending it — no SMS provider account exists yet. It never
throws, so the full `POST /otp/send` success path is testable locally without
any real SMS. Every code sent locally is readable in the server's stdout:

```
[DEV SMS] Would send to +971501234567: Your Tawasi Plus verification code is 123456. It expires in 5 minutes.
```

**Wiring a real provider (e.g. Twilio) is a single-file change**: replace the
body of `send()` with a real API call. It should resolve on confirmed
delivery and reject/throw on failure — `POST /otp/send`'s handler already
catches a throw from `send()` and responds `503`, so no caller-side change is
needed. Do not change the function's signature without updating both call
sites (`POST /otp/send` and any future caller).

## Running locally

The Saleor stack (`saleor_platform`) must already be up.

```bash
npm install
cp .env.example .env
npm run dev
```

Other scripts:

```bash
npm run build       # compile TypeScript to dist/
npm start           # run the compiled build
npm run typecheck   # tsc --noEmit
```

## Running in Docker

```bash
docker build -t proton-identity:local .

docker run -d --name proton-identity \
  --network saleor_platform_saleor-backend-tier -p 5001:5001 \
  -e DATABASE_URL=postgres://saleor:saleor@db:5432/saleor \
  -e SERVICE_TOKEN=<real-token> \
  proton-identity:local
```

Adding this service to `saleor_platform`'s `docker-compose.yml` is
deliberately **not** done yet — a separate follow-up session, same as
`proton_analytics`.

## API

### `POST /phones`

Normalizes and stores a phone number for a user. Upserts on `user_id` — a
repeat call for the same user with a new number **overwrites** the old one
("immutable-ish", not literally immutable).

```
Request:  { "userId": "VXNlcjox", "phone": "0501234567" }
200:      { "phone": "+971501234567" }
400:      { "error": "userId must be a non-empty string" }
400:      { "error": "phone is not a valid phone number" }
409:      { "error": "this phone is already registered to another account" }
503:      { "error": "could not save phone" }              // Postgres unreachable
401:      { "error": "unauthorized" }                        // missing/wrong token
```

Phone normalization uses `libphonenumber-js`. A number given without a `+`
or country code is assumed to be in the UAE (`AE`) region — this project's
primary market — e.g. `0501234567`, `971501234567`, and `+971501234567` all
normalize to the same `+971501234567`. A number with an explicit country
code normalizes correctly regardless of region.

The `409` case is detected via the table's `UNIQUE(phone_e164)` constraint
(Postgres error code `23505`), not a pre-check-then-insert race — the
constraint is the actual source of truth, so this is safe under concurrent
requests for the same phone number.

### `GET /phones/status/:userId`

Returns only a boolean — deliberately **not** the phone number itself, to
minimize PII exposure on this lower-stakes "just checking" endpoint. This is
what a future storefront login-gate calls: block/redirect any authenticated
user with `hasPhone: false`, regardless of how they reached that state
(fresh registration, pre-existing account from before this feature shipped,
etc.).

```
200:      { "hasPhone": true }
200:      { "hasPhone": false }
503:      { "error": "status unavailable" }
401:      { "error": "unauthorized" }
```

`userId` is a Saleor global ID (base64-encoded) and may contain `+`, `/`, or
`=`. Callers **must** `encodeURIComponent()` it before building the path.

### `GET /phones/lookup?phone=<value>`

**Future OTP integration point.** Not called by anything yet — this is the
endpoint a future OTP-login feature will call with a phone number a user
just typed in, to resolve it to a Saleor account before sending/verifying a
one-time code. The query param is normalized the same way as `POST /phones`,
so callers may pass a raw local-format number, not just E.164.

```
200:      { "userId": "VXNlcjox" }
400:      { "error": "phone is not a valid phone number" }
404:      { "error": "no account found for this phone number" }
503:      { "error": "lookup unavailable" }
401:      { "error": "unauthorized" }
```

### `POST /otp/send`

Generates and "sends" (see "SMS delivery" above) a 6-digit code for a phone
number. Not tied to `user_phones` at all — a phone can request a code before
any account exists for it (see `POST /otp/verify`'s `userId: null` case).

```
Request:  { "phone": "0501234567" }
200:      { "sent": true, "expiresInSeconds": 300 }
400:      { "error": "phone is not a valid phone number" }
429:      { "error": "resend_too_soon" }   // a non-expired, non-consumed code was issued < 60s ago
429:      { "error": "rate_limited" }      // 5+ codes already requested for this phone in the last hour
503:      { "error": "could not send code" }
401:      { "error": "unauthorized" }
```

Rate limits, and why:
- **60s resend cooldown** — the ordinary "didn't get it, resend" case is
  still fast, but a tight retry loop can't multiply SMS spend or hammer the
  provider.
- **5 sends/hour per phone** — independent of the cooldown (a caller who
  patiently waits out each 60s cooldown could otherwise resend indefinitely);
  this is the actual ceiling on SMS cost from abuse against one number.
- Both are enforced against `phone_e164` only, not IP — this service sits
  behind `SERVICE_TOKEN`, so the caller is always the same trusted internal
  service (the storefront route, later a Saleor plugin), not the end user's
  browser directly; per-phone limits are what actually matters here.

### `POST /otp/verify`

Checks a code against the most recently issued, still-unconsumed code for
that phone. Codes are **single-use** — a successful verify immediately marks
the row `consumed`, so replaying the same correct code again always reports
`expired_or_not_found`, never a second success.

```
Request:  { "phone": "0501234567", "code": "123456" }
200:      { "verified": true, "userId": "VXNlcjox" }   // phone is linked to an account
200:      { "verified": true, "userId": null }         // ownership verified, no account linked yet
400:      { "error": "phone is not a valid phone number" }
400:      { "error": "code must be a non-empty string" }
400:      { "error": "expired_or_not_found" }
400:      { "error": "invalid_code", "attemptsRemaining": 4 }
429:      { "error": "too_many_attempts" }   // 5 wrong guesses already made against this code — refused outright, even with the correct code
503:      { "error": "verification unavailable" }
401:      { "error": "unauthorized" }
```

`userId: null` is a **valid, successful outcome**, not an error — this
service's job is only to report the facts (ownership verified; account
linked or not) accurately. What "verified but no account" *means* is a
decision for the caller (a future Saleor plugin implementing
`external_obtain_access_tokens` — see the passwordless-login research
session for why that's the sanctioned mechanism and what it requires).

5-attempt lockout is checked, and enforced, **before** the hash comparison —
a code that has already hit the cap is refused outright on every subsequent
call, correct guess or not, rather than silently counting attempts past the
limit.

### `GET /health`

Actively checks Postgres (`SELECT 1`) and is the **only** unauthenticated
route. Used for the Docker healthcheck.

```
200:      { "status": "ok" }
503:      { "status": "error", "reason": "..." }
```

## Postgres schema

```sql
CREATE TABLE IF NOT EXISTS user_phones (
    user_id     TEXT PRIMARY KEY,
    phone_e164  TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
    id          SERIAL PRIMARY KEY,
    phone_e164  TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    consumed    BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_codes_phone_e164_idx ON otp_codes (phone_e164);
```

Created idempotently at startup. No ORM and no migration framework — a
single raw statement is sufficient at this scope, same as
`proton_analytics`. The `UNIQUE` constraint on `user_phones.phone_e164` is
load-bearing: it enforces "one phone per account, one account per phone" at
the database level, and `POST /phones`'s `409` response depends on it
firing. `otp_codes` has no such constraint and no foreign key to
`user_phones` — a phone can have several outstanding rows (rate limits above
bound how many) and can be verifying ownership before any `user_phones` row
exists for it at all.

`code_hash` stores a plain SHA-256 hex digest — never the raw code, even
though codes are short-lived, in case the database is ever exposed. Codes are
compared via the same constant-time helper (`constantTimeEqual`, `auth.ts`)
already used for the `SERVICE_TOKEN` check.

## Known dependency advisories

`npm audit` reports 2 moderate advisories, both via `express` 4's `qs`
dependency (DoS via attacker-controlled query strings) — the same advisory
`proton_analytics` documents and deliberately leaves unaddressed pending an
`express` 5 major-version bump. Here it is slightly more relevant than in
`proton_analytics` since `GET /phones/lookup` does take a query string from
a caller, but that caller is still only ever another internal service
behind `SERVICE_TOKEN`, not a public client — revisit if this service is
ever exposed beyond the internal network.
