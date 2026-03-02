import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext } from "playwright";
import {
  normalizeUniuniTracking,
  type UniuniTrackingApiResponse,
} from "./normalize-uniuni.js";
import type { ScrapeOptions, ShipmentInfo } from "./types.js";

const chromiumWithFlags = chromium as typeof chromium & {
  __packtStealthApplied?: boolean;
};

if (!chromiumWithFlags.__packtStealthApplied) {
  chromium.use(StealthPlugin());
  chromiumWithFlags.__packtStealthApplied = true;
}

const UNIUNI_TRACKING_PAGE_URL = "https://www.uniuni.com/tracking/";
const UNIUNI_API_DOMAIN_DEFAULT = "https://delivery-api.uniuni.ca";
const UNIUNI_TRACKING_PATH = "/cargo/trackinguniuninew";
const UNIUNI_TRACKING_URL = "https://www.uniuni.com/tracking/";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface BrowserSession {
  context: BrowserContext;
  close: () => Promise<void>;
}

function compact(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function ensureTrackingNumber(trackingNumber: string): string {
  const normalized = trackingNumber.trim().toUpperCase();
  if (!/^[A-Za-z0-9]{8,35}$/.test(normalized)) {
    throw new Error("Invalid UniUni tracking number format");
  }
  return normalized;
}

function getExecutablePath(): string | undefined {
  if (process.env.UNIUNI_BROWSER_EXECUTABLE_PATH) {
    return process.env.UNIUNI_BROWSER_EXECUTABLE_PATH;
  }

  if (process.env.USPS_BROWSER_EXECUTABLE_PATH) {
    return process.env.USPS_BROWSER_EXECUTABLE_PATH;
  }

  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  return undefined;
}

async function createBrowserSession(timeoutMs: number): Promise<BrowserSession> {
  const cdpEndpoint =
    process.env.UNIUNI_CDP_WS_ENDPOINT?.trim() ||
    process.env.USPS_CDP_WS_ENDPOINT?.trim();

  const contextOptions = {
    locale: "en-US",
    timezoneId:
      process.env.UNIUNI_TIMEZONE ??
      process.env.USPS_TIMEZONE ??
      "America/New_York",
    userAgent:
      process.env.UNIUNI_USER_AGENT ??
      process.env.USPS_USER_AGENT ??
      DEFAULT_USER_AGENT,
    viewport: { width: 1366, height: 900 },
  };

  if (cdpEndpoint) {
    const browser = await chromium.connectOverCDP(cdpEndpoint, {
      timeout: timeoutMs,
    });

    if (browser.contexts().length > 0) {
      const context = browser.contexts()[0];
      return {
        context,
        close: async () => {
          await browser.close();
        },
      };
    }

    const context = await browser.newContext(contextOptions);
    return {
      context,
      close: async () => {
        await context.close();
        await browser.close();
      },
    };
  }

  const browser: Browser = await chromium.launch({
    headless: process.env.UNIUNI_HEADFUL === "1" ? false : true,
    executablePath: getExecutablePath(),
    args: [
      "--disable-blink-features=AutomationControlled",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--use-angle=default",
      "--use-gl=angle",
      "--enable-zero-copy",
      "--enable-accelerated-2d-canvas",
    ],
  });

  const context = await browser.newContext(contextOptions);
  return {
    context,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

function resolveTrackingKey(pageHtml: string): string | undefined {
  const fromEnv = compact(process.env.UNIUNI_TRACKING_KEY);
  if (fromEnv) {
    return fromEnv;
  }

  const keyPattern = /trackinguniuninew\?id="\s*\+\s*no\s*\+\s*"&key=([A-Za-z0-9]+)/i;
  const keyMatch = pageHtml.match(keyPattern);
  return keyMatch?.[1];
}

async function fetchUniuniPayload(
  trackingNumber: string,
  timeoutMs: number
): Promise<UniuniTrackingApiResponse> {
  const session = await createBrowserSession(timeoutMs);

  try {
    const page = await session.context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    });

    await page.goto(UNIUNI_TRACKING_PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    await page.waitForTimeout(1500);

    const pageHtml = await page.content();
    const trackingKey = resolveTrackingKey(pageHtml);
    if (!trackingKey) {
      throw new Error("Unable to resolve UniUni tracking API key");
    }

    const apiDomain =
      compact(process.env.UNIUNI_DELIVERY_API_DOMAIN) ?? UNIUNI_API_DOMAIN_DEFAULT;
    const apiUrl = `${apiDomain}${UNIUNI_TRACKING_PATH}?id=${encodeURIComponent(
      trackingNumber
    )}&key=${encodeURIComponent(trackingKey)}`;

    const payload = await page.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "GET",
        credentials: "omit",
      });

      if (!response.ok) {
        throw new Error(`UniUni tracking API request failed (${response.status})`);
      }

      return (await response.json()) as unknown;
    }, apiUrl);

    return payload as UniuniTrackingApiResponse;
  } finally {
    await session.close();
  }
}

export async function scrapeUniuniTracking(
  trackingNumber: string,
  options: ScrapeOptions = {}
): Promise<ShipmentInfo> {
  const normalizedTrackingNumber = ensureTrackingNumber(trackingNumber);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const parsedMaxAttempts = Number(
    process.env.UNIUNI_SCRAPE_MAX_ATTEMPTS ??
      process.env.USPS_SCRAPE_MAX_ATTEMPTS ??
      "6"
  );
  const maxAttempts =
    Number.isInteger(parsedMaxAttempts) && parsedMaxAttempts > 0
      ? parsedMaxAttempts
      : 6;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await fetchUniuniPayload(normalizedTrackingNumber, timeoutMs);
      return normalizeUniuniTracking(
        normalizedTrackingNumber,
        UNIUNI_TRACKING_URL,
        payload
      );
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error("UniUni scraping failed");

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw lastError ?? new Error("UniUni scraping failed");
}
