function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

interface NormalizedAmazonImportPayload {
  payload: Record<string, unknown>;
  totpKey?: string;
}

interface ScraperImportResponse {
  response: Response;
  result: Record<string, unknown>;
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

function normalizePayload(raw: unknown): NormalizedAmazonImportPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Payload must be an object");
  }

  const input = raw as Record<string, unknown>;
  const username = normalizeString(input.username);
  const password = normalizeString(input.password);
  const challengeId = normalizeString(input.challengeId);
  const totpCode = normalizeString(input.totpCode);
  const totpKey =
    normalizeString(input.totpKey) ?? normalizeString(input.totpSecret);
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
  return { payload, totpKey };
}

function withEnvDefaults(
  payload: Record<string, unknown>,
  env: Record<string, string | undefined>
): Record<string, unknown> {
  const merged = { ...payload };
  if (typeof merged.maxShipments === "undefined") {
    const value = normalizeInteger(env.AMAZON_IMPORT_DEFAULT_MAX_SHIPMENTS);
    if (typeof value === "number") {
      merged.maxShipments = value;
    }
  }
  if (typeof merged.lookbackDays === "undefined") {
    const value = normalizeInteger(env.AMAZON_IMPORT_DEFAULT_LOOKBACK_DAYS);
    if (typeof value === "number") {
      merged.lookbackDays = value;
    }
  }
  if (typeof merged.archiveDelivered === "undefined") {
    const value = normalizeBoolean(env.AMAZON_IMPORT_DEFAULT_ARCHIVE_DELIVERED);
    if (typeof value === "boolean") {
      merged.archiveDelivered = value;
    }
  }
  return merged;
}

function decodePercentEscapes(value: string): string {
  if (!/%[0-9a-f]{2}/i.test(value)) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractTotpSecret(rawValue: string): string {
  const value = rawValue.trim();
  if (!value) {
    throw new Error("TOTP key is empty");
  }

  if (value.toLowerCase().startsWith("otpauth://")) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(
        "TOTP key must be a valid Base32 string (A-Z and 2-7), or an otpauth:// URI."
      );
    }
    const secret = normalizeString(parsed.searchParams.get("secret"));
    if (!secret) {
      throw new Error(
        "otpauth URI is missing the required secret query parameter."
      );
    }
    return decodePercentEscapes(secret);
  }

  return decodePercentEscapes(value);
}

function decodeBase32Secret(secret: string): Uint8Array {
  const normalized = extractTotpSecret(secret)
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/=+$/g, "");
  if (!normalized) {
    throw new Error("TOTP key is empty");
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error(
        "TOTP key must be a valid Base32 string (A-Z and 2-7), or an otpauth:// URI."
      );
    }

    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  if (output.length === 0) {
    throw new Error("TOTP key could not be decoded");
  }

  return new Uint8Array(output);
}

function getWebCrypto(): Crypto {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  throw new Error("Web Crypto is unavailable in this runtime");
}

async function generateTotpCode(secret: string): Promise<string> {
  const cryptoApi = getWebCrypto();
  const secretBytes = decodeBase32Secret(secret);
  let counter = Math.floor(Date.now() / 1000 / 30);
  const message = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    message[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }

  const key = await cryptoApi.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await cryptoApi.subtle.sign("HMAC", key, message)
  );
  const offset = signature[signature.length - 1] & 0x0f;
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);
  const otp = binary % 1_000_000;
  return String(otp).padStart(6, "0");
}

function normalizeResultBody(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, unknown>;
}

async function postScraperImport(
  baseUrl: string,
  token: string | undefined,
  payload: Record<string, unknown>,
  signal: AbortSignal
): Promise<ScraperImportResponse> {
  const response = await fetch(`${baseUrl}/amazon/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { "x-amazon-scraper-token": token } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });

  const result = normalizeResultBody(
    await response
      .json()
      .catch(() => ({ error: "Amazon scraper returned invalid JSON" }))
  );

  return { response, result };
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

  let normalized: NormalizedAmazonImportPayload;
  try {
    normalized = normalizePayload(rawBody);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid import payload";
    return jsonResponse({ error: message }, 400);
  }
  const totpKey = normalized.totpKey;
  const payload = withEnvDefaults(normalized.payload, env);

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
    const primaryAttempt = await postScraperImport(
      baseUrl,
      token,
      payload,
      controller.signal
    );
    if (!primaryAttempt.response.ok && primaryAttempt.response.status !== 202) {
      return jsonResponse(
        {
          error:
            typeof primaryAttempt.result.error === "string"
              ? primaryAttempt.result.error
              : `Amazon scraper request failed (${primaryAttempt.response.status})`,
        },
        primaryAttempt.response.status >= 400 &&
          primaryAttempt.response.status < 600
          ? primaryAttempt.response.status
          : 500
      );
    }

    const shouldAutoGenerateTotp =
      !payload.challengeId &&
      Boolean(totpKey) &&
      primaryAttempt.result.status === "totp_required" &&
      typeof primaryAttempt.result.challengeId === "string";

    if (!shouldAutoGenerateTotp) {
      return jsonResponse(primaryAttempt.result, primaryAttempt.response.status);
    }

    try {
      const totpCode = await generateTotpCode(totpKey!);
      const followupAttempt = await postScraperImport(
        baseUrl,
        token,
        {
          challengeId: primaryAttempt.result.challengeId,
          totpCode,
        },
        controller.signal
      );

      if (!followupAttempt.response.ok && followupAttempt.response.status !== 202) {
        return jsonResponse(
          {
            error:
              typeof followupAttempt.result.error === "string"
                ? followupAttempt.result.error
                : `Amazon scraper request failed (${followupAttempt.response.status})`,
          },
          followupAttempt.response.status >= 400 &&
            followupAttempt.response.status < 600
            ? followupAttempt.response.status
            : 500
        );
      }

      return jsonResponse(followupAttempt.result, followupAttempt.response.status);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Automatic TOTP generation failed";
      return jsonResponse(
        {
          ...primaryAttempt.result,
          autoTotpError: message,
        },
        202
      );
    }
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
