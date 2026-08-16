// Trimmed environment access.
//
// Values arrive with stray whitespace often enough to be worth defending against: a
// leading space in a pasted TFI_API_KEY produced a stream of 401s that looked exactly
// like a bad key, twice. Node's dotenv trims unquoted values but shell `source` does not,
// so the same file behaves differently depending on who reads it. Reading through here
// makes that class of failure impossible regardless of how the value got in.

export function env(name, fallback = undefined) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim().replace(/^["']|["']$/g, '');
  return trimmed === '' ? fallback : trimmed;
}

export function requireEnv(name) {
  const v = env(name);
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}
