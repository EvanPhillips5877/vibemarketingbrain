// The one place a secret is looked up by name. Today a name is an
// environment variable; in production (Phase 8) the deploy populates the
// environment from the secret store before the process starts, so this
// stays the same. Callers never log what comes back.
export function getSecret(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ref) return null;
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(ref)) return null; // a name, never a value
  const v = env[ref];
  return v && v.trim().length > 0 ? v.trim() : null;
}
