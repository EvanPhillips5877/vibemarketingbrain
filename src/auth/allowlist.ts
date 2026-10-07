// The only question this module answers: may this address have a session?
// Addresses are compared lower-cased and trimmed. An empty allowlist admits
// nobody; config refuses to start in production without one.
export function isAllowed(email: string, allowed: readonly string[]): boolean {
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return false;
  return allowed.includes(e);
}
