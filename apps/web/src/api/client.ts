export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

let csrfToken: string | undefined;

export function newIdempotencyKey() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();

  // randomUUID is restricted to secure contexts. getRandomValues also works
  // over the app's supported HTTP-by-IP deployment.
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

async function ensureCsrfToken() {
  if (csrfToken) return csrfToken;
  const response = await fetch("/api/v1/auth/csrf", {
    credentials: "same-origin",
  });
  if (!response.ok)
    throw new ApiClientError(
      "无法建立安全会话",
      response.status,
      "CSRF_INIT_FAILED",
    );
  const payload = (await response.json()) as { data: { token: string } };
  csrfToken = payload.data.token;
  return csrfToken;
}

export function clearCsrfToken() {
  csrfToken = undefined;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("x-csrf-token", await ensureCsrfToken());
  }
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json()) as {
    data?: T;
    error?: { message?: string; code?: string };
  };
  if (!response.ok) {
    if (response.status === 401) clearCsrfToken();
    throw new ApiClientError(
      payload.error?.message ?? "请求失败，请稍后再试。",
      response.status,
      payload.error?.code ?? "REQUEST_FAILED",
    );
  }
  return payload.data as T;
}

export const postJson = <T>(path: string, body: unknown) =>
  apiRequest<T>(path, { method: "POST", body: JSON.stringify(body) });

export const patchJson = <T>(path: string, body: unknown) =>
  apiRequest<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const deleteJson = <T>(path: string, body: unknown) =>
  apiRequest<T>(path, {
    method: "DELETE",
    body: JSON.stringify(body),
  });
