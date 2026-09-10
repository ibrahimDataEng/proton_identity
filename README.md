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
2. **Future OTP-login** — see "Future OTP integration point" below.

## Design constraints

This service is **fully independent** of `proton_storefront` and
`proton_platform` (Saleor), mirroring the `proton_analytics` precedent:

- It does **not** modify the Saleor image, Dockerfile, `settings.py`, or
  `urls.py`.
- It has zero coupling to Saleor's codebase or deployment lifecycle.
- It owns exactly one, uniquely named Postgres table, `user_phones`, in the
  same `saleor` database. The name was checked against existing tables — no
  collision.
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
```

Created idempotently at startup. No ORM and no migration framework — a
single raw statement is sufficient at this scope, same as
`proton_analytics`. The `UNIQUE` constraint on `phone_e164` is load-bearing:
it enforces "one phone per account, one account per phone" at the database
level, and `POST /phones`'s `409` response depends on it firing.

## Known dependency advisories

`npm audit` reports 2 moderate advisories, both via `express` 4's `qs`
dependency (DoS via attacker-controlled query strings) — the same advisory
`proton_analytics` documents and deliberately leaves unaddressed pending an
`express` 5 major-version bump. Here it is slightly more relevant than in
`proton_analytics` since `GET /phones/lookup` does take a query string from
a caller, but that caller is still only ever another internal service
behind `SERVICE_TOKEN`, not a public client — revisit if this service is
ever exposed beyond the internal network.
