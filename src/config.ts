import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback;
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

export const config = {
	port: Number(process.env.PORT ?? 5001),
	databaseUrl: required("DATABASE_URL", "postgres://saleor:saleor@localhost:5432/saleor"),
	/** Empty until a real secret is generated and set — see .env.example / README. */
	serviceToken: process.env.SERVICE_TOKEN ?? "",
};

/** Region assumed for phone numbers given without a leading "+" / explicit country code. */
export const DEFAULT_PHONE_REGION = "AE";
