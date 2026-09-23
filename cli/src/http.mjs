export class DocketApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "DocketApiError";
    this.status = status;
    this.code = code;
  }
}

function apiUrl(config, path) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Invalid Docket API path");
  }
  return `${config.apiBaseUrl}${path}`;
}

async function throwForHttpError(response) {
  if (response.ok) return;
  let payload;
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      // The response body may be empty or malformed; keep the status.
    }
  }
  const detail = typeof payload?.detail === "string" ? payload.detail : null;
  const code = typeof payload?.code === "string" ? payload.code : undefined;
  throw new DocketApiError(detail || `Docket API returned HTTP ${response.status}`, {
    status: response.status,
    code,
  });
}

export async function fetchApi(config, path, {
  auth,
  fetchImpl = fetch,
  method = "GET",
  body,
  accept = "application/json",
} = {}) {
  const url = apiUrl(config, path);
  async function send(forceRefresh) {
    const headers = { Accept: accept };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) headers.Authorization = `Bearer ${await auth.token({ forceRefresh })}`;
    return fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  let response = await send(false);
  // Auth middleware rejects this request before entering a route. A fresh
  // token can recover a stale token without prompting the user to sign in.
  if (auth && method.toUpperCase() === "GET" && response.status === 401) {
    response = await send(true);
  }
  await throwForHttpError(response);
  return response;
}

export async function requestJson(config, path, options) {
  const response = await fetchApi(config, path, options);
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new DocketApiError("Docket API returned invalid JSON", {
      status: response.status,
    });
  }
}

export function pathSegment(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("An ID is required");
  }
  return encodeURIComponent(value.trim());
}
