import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { normalizeUspsTracking, type RawUspsTracking } from "./normalize.js";
import type { ScrapeOptions, ShipmentInfo } from "./types.js";

chromium.use(StealthPlugin());

const TRACKING_LANDING_URL = "https://www.usps.com/tracking/";
const TRACKING_URL_BASE =
  "https://tools.usps.com/go/TrackConfirmAction.action?tLabels=";
const DEFAULT_TIMEOUT_MS = 60_000;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface BrowserSession {
  context: BrowserContext;
  close: () => Promise<void>;
}

function normalizeSpace(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function ensureTrackingNumber(trackingNumber: string): string {
  const normalized = trackingNumber.trim();
  if (!/^[A-Za-z0-9]{8,35}$/.test(normalized)) {
    throw new Error("Invalid USPS tracking number format");
  }
  return normalized;
}

function getExecutablePath(): string | undefined {
  if (process.env.USPS_BROWSER_EXECUTABLE_PATH) {
    return process.env.USPS_BROWSER_EXECUTABLE_PATH;
  }

  // Default path on macOS developer environments.
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  return undefined;
}

async function createBrowserSession(timeoutMs: number): Promise<BrowserSession> {
  const cdpEndpoint = process.env.USPS_CDP_WS_ENDPOINT?.trim();

  const contextOptions = {
    locale: "en-US",
    timezoneId: process.env.USPS_TIMEZONE ?? "America/New_York",
    userAgent: process.env.USPS_USER_AGENT ?? DEFAULT_USER_AGENT,
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
    headless: process.env.USPS_HEADFUL === "1" ? false : true,
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

async function extractTrackingFromDom(
  page: Page,
  requestedTrackingNumber: string,
  trackingUrl: string
): Promise<RawUspsTracking> {
  const firstText = async (
    locator: Locator,
    selector: string
  ): Promise<string | undefined> => {
    const texts = await locator.locator(selector).allTextContents();
    return normalizeSpace(texts[0]);
  };

  const safeText = async (selector: string): Promise<string | undefined> =>
    firstText(page.locator("body"), selector);

  const trackingNumber =
    (await safeText(".tracking-number")) ?? requestedTrackingNumber;

  const stepLocators = await page.locator(".tb-step").all();
  const events: Array<{
    code?: string;
    description: string;
    timestamp: string;
    location?: string;
  }> = [];

  for (const step of stepLocators) {
    const description = normalizeSpace(
      (await firstText(step, ".tb-status-detail")) ??
        (await firstText(step, ".tb-status"))
    );
    const timestamp = await firstText(step, ".tb-date");
    const location = await firstText(step, ".tb-location");
    const code = await firstText(step, ".tb-status");

    if (!description || !timestamp) continue;

    events.push({
      code,
      description,
      timestamp,
      location,
    });
  }

  const currentStep = page.locator(".tb-step.current-step").first();
  const hasCurrentStep = (await currentStep.count()) > 0;

  const statusDescription = hasCurrentStep
    ? normalizeSpace(
        (await firstText(currentStep, ".tb-status-detail")) ??
          (await firstText(currentStep, ".tb-status"))
      )
    : await safeText(".banner-content");
  const statusTimestamp = hasCurrentStep
    ? await firstText(currentStep, ".tb-date")
    : undefined;
  const statusLocation = hasCurrentStep
    ? await firstText(currentStep, ".tb-location")
    : undefined;
  const statusCode = hasCurrentStep
    ? await firstText(currentStep, ".tb-status")
    : undefined;

  const estimatedDelivery = await safeText(".expected_delivery");

  return {
    trackingNumber,
    trackingUrl,
    statusCode,
    statusDescription,
    statusTimestamp,
    statusLocation,
    estimatedDelivery,
    events,
  };
}

async function fetchTrackingPage(
  page: Page,
  trackingNumber: string,
  timeoutMs: number
): Promise<string> {
  await page.goto(TRACKING_LANDING_URL, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });

  // Give challenge scripts time to settle before requesting results.
  await page.waitForTimeout(1500);

  const trackingUrls = [
    `${TRACKING_URL_BASE}${encodeURIComponent(trackingNumber)}`,
    `https://tools.usps.com/go/TrackConfirmAction?tRef=fullpage&tLc=2&text28777=&tLabels=${encodeURIComponent(
      trackingNumber
    )}`,
  ];

  const selectorTimeout = Math.min(30_000, timeoutMs);
  let lastError: Error | undefined;

  for (const trackingUrl of trackingUrls) {
    try {
      const response = await page.goto(trackingUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      if (!response || !response.ok()) {
        const status = response?.status() ?? "unknown";
        throw new Error(
          `USPS tracking page request failed (${trackingUrl}) status ${status}`
        );
      }

      await page.waitForSelector(".tracking-number", {
        timeout: selectorTimeout,
      });

      await page.waitForSelector(".tb-step", {
        timeout: selectorTimeout,
      });

      return trackingUrl;
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("USPS tracking page request failed");
    }
  }

  throw lastError ?? new Error("USPS tracking page request failed");
}

export async function scrapeUspsTracking(
  trackingNumber: string,
  options: ScrapeOptions = {}
): Promise<ShipmentInfo> {
  const normalizedTrackingNumber = ensureTrackingNumber(trackingNumber);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const maxAttempts = Number(process.env.USPS_SCRAPE_MAX_ATTEMPTS ?? "2");
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const session = await createBrowserSession(timeoutMs);

    try {
      const page = await session.context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
        });
      });

      const trackingUrl = await fetchTrackingPage(
        page,
        normalizedTrackingNumber,
        timeoutMs
      );

      const raw = await extractTrackingFromDom(
        page,
        normalizedTrackingNumber,
        trackingUrl
      );

      if (!raw.events.length) {
        const bodyText = normalizeSpace(await page.textContent("body"));
        if (bodyText?.includes("tracking information is not available")) {
          throw new Error("USPS tracking information is not available");
        }
        throw new Error("USPS tracking response did not include events");
      }

      return normalizeUspsTracking(raw);
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error("USPS scraping failed");

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    } finally {
      await session.close();
    }
  }

  throw lastError ?? new Error("USPS scraping failed");
}
