// The one fetch wrapper. GETs are plain; mutations carry the CSRF token the
// server handed out with /api/me.
export interface Me {
  user: { email: string; name: string | null };
  csrfToken: string;
  env: "development" | "test" | "production";
  authMode: "google" | "dev";
  mock: { ai: boolean; meta: boolean; googleAds: boolean };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export function rememberCsrf(token: string): void {
  csrfToken = token;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  const res = await fetch(path, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}
