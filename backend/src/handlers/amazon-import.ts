function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.floor(parsed);
}

function normalizePayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Payload must be an object");
  }

  const input = raw as Record<string, unknown>;
  const username = normalizeString(input.username);
  const password = normalizeString(input.password);
  const challengeId = normalizeString(input.challengeId);
  const totpCode = normalizeString(input.totpCode);
  const maxShipments = normalizeInteger(input.maxShipments);
  const lookbackDays = normalizeInteger(input.lookbackDays);
  const archiveDelivered = normalizeBoolean(input.archiveDelivered);
  const timeoutMs = normalizeInteger(input.timeoutMs);

  if (!challengeId && (!username || !password)) {
    throw new Error(
      "username and password are required when challengeId is not provided"
    );
  }
  if (challengeId && !totpCode) {
    throw new Error("totpCode is required when challengeId is provided");
  }

  const payload: Record<string, unknown> = {};
  if (username) payload.username = username;
  if (password) payload.password = password;
  if (challengeId) payload.challengeId = challengeId;
  if (totpCode) payload.totpCode = totpCode;
  if (typeof maxShipments === "number") payload.maxShipments = maxShipments;
  if (typeof lookbackDays === "number") payload.lookbackDays = lookbackDays;
  if (typeof archiveDelivered === "boolean") {
    payload.archiveDelivered = archiveDelivered;
  }
  if (typeof timeoutMs === "number") payload.timeoutMs = timeoutMs;
  return payload;
}

export async function handleAmazonImport(
  request: Request,
  env: Record<string, string | undefined>
): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  let payload: Record<string, unknown>;
  try {
    payload = normalizePayload(rawBody);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid import payload";
    return jsonResponse({ error: message }, 400);
  }

  const baseUrl = (
    env.AMAZON_SCRAPER_URL ??
    env.USPS_SCRAPER_URL ??
    "http://127.0.0.1:8790"
  ).replace(/\/$/, "");
  const token = normalizeString(env.AMAZON_SCRAPER_TOKEN);
  const parsedTimeoutMs = Number(env.AMAZON_SCRAPER_TIMEOUT_MS ?? "300000");
  const timeoutMs =
    Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
      ? parsedTimeoutMs
      : 300000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/amazon/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(token ? { "x-amazon-scraper-token": token } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const result = await response
      .json()
      .catch(() => ({ error: "Amazon scraper returned invalid JSON" }));

    if (!response.ok && response.status !== 202) {
      return jsonResponse(
        {
          error:
            typeof result?.error === "string"
              ? result.error
              : `Amazon scraper request failed (${response.status})`,
        },
        response.status >= 400 && response.status < 600 ? response.status : 500
      );
    }

    return jsonResponse(result, response.status);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return jsonResponse({ error: "Amazon import timed out" }, 504);
    }
    const message = error instanceof Error ? error.message : "Amazon import failed";
    return jsonResponse({ error: message }, 500);
  } finally {
    clearTimeout(timeout);
  }
}
