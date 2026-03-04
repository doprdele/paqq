import { randomUUID } from "node:crypto";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "playwright";
import type {
  AmazonImportRequest,
  AmazonImportResponse,
  AmazonImportedShipment,
  ShipmentStatus,
} from "./types.js";
import {
  persistCarrierSessionState,
  withCarrierSessionState,
} from "./session-state.js";

const chromiumWithFlags = chromium as typeof chromium & {
  __paqqStealthApplied?: boolean;
};

if (!chromiumWithFlags.__paqqStealthApplied) {
  chromium.use(StealthPlugin());
  chromiumWithFlags.__paqqStealthApplied = true;
}

const AMAZON_SIGNIN_URL =
  "https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fgp%2Fyour-account%2Forder-history";
const AMAZON_ORDERS_URL = "https://www.amazon.com/gp/your-account/order-history";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MAX_SHIPMENTS = 15;
const MAX_LOOKBACK_DAYS = 365;
const MAX_SHIPMENTS = 75;
const MAX_ORDER_PAGES = 8;
const TOTP_SESSION_TTL_MS = 10 * 60 * 1000;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface BrowserSession {
  context: BrowserContext;
  close: () => Promise<void>;
}

interface NormalizedImportConfig {
  username: string;
  password: string;
  lookbackDays: number;
  maxShipments: number;
  archiveDelivered: boolean;
  timeoutMs: number;
}

interface AmazonOrderLink {
  orderId?: string;
  orderDateText?: string;
  detailUrl: string;
}

interface AmazonRawStatus {
  description?: string;
  timestamp?: string;
  location?: string;
}

interface AmazonRawShipment {
  shipmentId?: string;
  orderId?: string;
  orderDateText?: string;
  status?: AmazonRawStatus;
  trackingNumber?: string;
  trackingUrl?: string;
  estimatedDelivery?: string;
  carrierHint?: string;
  delivered: boolean;
  events: Array<AmazonRawStatus>;
  itemTitles: string[];
  invoiceUrl?: string;
  sourceUrl: string;
}

interface PendingTotpSession {
  id: string;
  expiresAt: number;
  createdAt: number;
  config: NormalizedImportConfig;
  session: BrowserSession;
  page: Page;
}

const pendingTotpSessions = new Map<string, PendingTotpSession>();

function compact(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed =
    typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.floor(parsed);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function getExecutablePath(): string | undefined {
  if (process.env.AMAZON_BROWSER_EXECUTABLE_PATH) {
    return process.env.AMAZON_BROWSER_EXECUTABLE_PATH;
  }
  if (process.env.USPS_BROWSER_EXECUTABLE_PATH) {
    return process.env.USPS_BROWSER_EXECUTABLE_PATH;
  }
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return undefined;
}

function parseAmazonDate(text: string | undefined): Date | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text
    .replace(/(\d+)(st|nd|rd|th)/gi, "$1")
    .replace(/ordered on/i, "")
    .replace(/order placed/i, "")
    .trim();
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function resolveCarrierName(hint: string | undefined): string {
  const lower = (hint ?? "").toLowerCase();
  if (lower.includes("ups")) return "ups";
  if (lower.includes("usps") || lower.includes("postal")) return "usps";
  if (lower.includes("uniuni")) return "uniuni";
  if (lower.includes("amazon")) return "amazon";
  return "amazon";
}

function resolveStatusCode(description: string, delivered: boolean): string {
  if (delivered) {
    return "5";
  }
  const lower = description.toLowerCase();
  if (lower.includes("out for delivery")) return "4";
  if (
    lower.includes("arrived") ||
    lower.includes("on the way") ||
    lower.includes("transit") ||
    lower.includes("shipped")
  ) {
    return "3";
  }
  if (lower.includes("preparing") || lower.includes("processing")) {
    return "2";
  }
  return "1";
}

function normalizeImportConfig(input: AmazonImportRequest): NormalizedImportConfig {
  const username = compact(input.username);
  const password = compact(input.password);
  if (!username || !password) {
    throw new Error("username and password are required");
  }

  const lookbackDays = parseBoundedInteger(
    input.lookbackDays,
    DEFAULT_LOOKBACK_DAYS,
    1,
    MAX_LOOKBACK_DAYS
  );
  const maxShipments = parseBoundedInteger(
    input.maxShipments,
    DEFAULT_MAX_SHIPMENTS,
    1,
    MAX_SHIPMENTS
  );
  const timeoutMs = parseBoundedInteger(
    input.timeoutMs ?? process.env.AMAZON_IMPORT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    10_000,
    5 * 60_000
  );
  const archiveDelivered = parseBoolean(input.archiveDelivered, true);

  return {
    username,
    password,
    lookbackDays,
    maxShipments,
    archiveDelivered,
    timeoutMs,
  };
}

async function createBrowserSession(timeoutMs: number): Promise<BrowserSession> {
  const cdpEndpoint =
    compact(process.env.AMAZON_CDP_WS_ENDPOINT) ??
    compact(process.env.USPS_CDP_WS_ENDPOINT);

  const contextOptions = await withCarrierSessionState("amazon", {
    locale: "en-US",
    timezoneId:
      process.env.AMAZON_TIMEZONE ??
      process.env.USPS_TIMEZONE ??
      "America/New_York",
    userAgent:
      process.env.AMAZON_USER_AGENT ??
      process.env.USPS_USER_AGENT ??
      DEFAULT_USER_AGENT,
    viewport: { width: 1440, height: 960 },
  } satisfies BrowserContextOptions);

  if (cdpEndpoint) {
    const browser = await chromium.connectOverCDP(cdpEndpoint, {
      timeout: timeoutMs,
    });
    if (browser.contexts().length > 0) {
      const context = browser.contexts()[0];
      return {
        context,
        close: async () => {
          await persistCarrierSessionState("amazon", context).catch(
            () => undefined
          );
          await browser.close();
        },
      };
    }

    const context = await browser.newContext(contextOptions);
    return {
      context,
      close: async () => {
        await persistCarrierSessionState("amazon", context).catch(
          () => undefined
        );
        await context.close();
        await browser.close();
      },
    };
  }

  const browser: Browser = await chromium.launch({
    headless: process.env.AMAZON_HEADFUL === "1" ? false : true,
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
      await persistCarrierSessionState("amazon", context).catch(
        () => undefined
      );
      await context.close();
      await browser.close();
    },
  };
}

async function cleanupExpiredTotpSessions(): Promise<void> {
  const now = Date.now();
  const expired = Array.from(pendingTotpSessions.values()).filter(
    (entry) => entry.expiresAt <= now
  );

  for (const entry of expired) {
    pendingTotpSessions.delete(entry.id);
    await entry.session.close().catch(() => undefined);
  }
}

async function hasSelector(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  return (await locator.count()) > 0;
}

async function findTotpSelector(page: Page): Promise<string | undefined> {
  const selectors = [
    "#auth-mfa-otpcode",
    "input[name='otpCode']",
    "input[name='code']",
    "input[id*='otp']",
  ];
  for (const selector of selectors) {
    if (await hasSelector(page, selector)) {
      return selector;
    }
  }
  return undefined;
}

async function findFirstVisibleSelector(
  page: Page,
  selectors: string[]
): Promise<string | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      return selector;
    }
  }
  return undefined;
}

async function clickIfPresent(page: Page, selectors: string[]): Promise<boolean> {
  const selector = await findFirstVisibleSelector(page, selectors);
  if (!selector) {
    return false;
  }
  await page.locator(selector).first().click();
  return true;
}

async function ensureNotBlocked(page: Page): Promise<void> {
  const bodyText = (await page.textContent("body"))?.toLowerCase() ?? "";
  if (bodyText.includes("enter the characters you see below")) {
    throw new Error(
      "Amazon requested CAPTCHA verification. Please retry and complete CAPTCHA manually."
    );
  }
}

async function signInWithPassword(
  page: Page,
  config: NormalizedImportConfig
): Promise<{ needsTotp: boolean }> {
  await page.goto(AMAZON_SIGNIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: config.timeoutMs,
  });
  await page.waitForTimeout(700);
  await ensureNotBlocked(page);

  if (await findTotpSelector(page)) {
    return { needsTotp: true };
  }

  if (!page.url().includes("/ap/")) {
    return { needsTotp: false };
  }

  if (await hasSelector(page, "#ap_email")) {
    await page.locator("#ap_email").fill(config.username);
    await clickIfPresent(page, [
      "#continue",
      "input[type='submit'][aria-labelledby='continue-announce']",
    ]);
    await page.waitForLoadState("domcontentloaded", { timeout: config.timeoutMs });
    await page.waitForTimeout(500);
    await ensureNotBlocked(page);

    if (await findTotpSelector(page)) {
      return { needsTotp: true };
    }

    if (!page.url().includes("/ap/")) {
      return { needsTotp: false };
    }
  }

  if (!(await hasSelector(page, "#ap_password"))) {
    try {
      await page.waitForSelector("#ap_password", { timeout: config.timeoutMs });
    } catch {
      // Continue with additional checks below.
    }
  }

  if (!(await hasSelector(page, "#ap_password"))) {
    if (await findTotpSelector(page)) {
      return { needsTotp: true };
    }
    if (!page.url().includes("/ap/")) {
      return { needsTotp: false };
    }
    throw new Error(
      "Amazon sign-in flow did not expose password input. Please retry."
    );
  }

  await page.locator("#ap_password").fill(config.password);
  await clickIfPresent(page, ["#signInSubmit", "input[type='submit']"]);
  await page.waitForLoadState("domcontentloaded", { timeout: config.timeoutMs });
  await page.waitForTimeout(700);
  await ensureNotBlocked(page);

  const totpSelector = await findTotpSelector(page);
  if (totpSelector) {
    return { needsTotp: true };
  }

  if (!page.url().includes("/ap/")) {
    return { needsTotp: false };
  }

  const bodyText = (await page.textContent("body"))?.toLowerCase() ?? "";
  if (
    bodyText.includes("incorrect") &&
    bodyText.includes("password") &&
    page.url().includes("/ap/")
  ) {
    throw new Error("Amazon sign-in failed. Verify username/password.");
  }

  return { needsTotp: false };
}

async function submitTotp(
  page: Page,
  config: NormalizedImportConfig,
  totpCode: string
): Promise<void> {
  const code = compact(totpCode);
  if (!code) {
    throw new Error("totpCode is required for this login challenge");
  }

  const totpSelector = await findTotpSelector(page);
  if (!totpSelector) {
    return;
  }

  await page.locator(totpSelector).first().fill(code);
  await clickIfPresent(page, [
    "#auth-signin-button",
    "input[type='submit']",
  ]);
  await page.waitForLoadState("domcontentloaded", { timeout: config.timeoutMs });
  await page.waitForTimeout(700);
  await ensureNotBlocked(page);

  if (await findTotpSelector(page)) {
    throw new Error("Amazon TOTP verification failed. Please try a fresh code.");
  }
}

async function hasAuthenticatedOrdersSession(
  page: Page,
  timeoutMs: number
): Promise<boolean> {
  await page.goto(`${AMAZON_ORDERS_URL}?opt=ab&digitalOrders=0`, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForTimeout(900);
  return !page.url().includes("/ap/signin");
}

async function ensureOrdersPage(
  page: Page,
  timeoutMs: number
): Promise<void> {
  const authenticated = await hasAuthenticatedOrdersSession(page, timeoutMs);
  if (!authenticated) {
    throw new Error(
      "Amazon session is not authenticated. Please retry and complete login."
    );
  }
}

async function collectOrderLinks(
  page: Page,
  maxLinks: number,
  timeoutMs: number
): Promise<AmazonOrderLink[]> {
  const results: AmazonOrderLink[] = [];
  const seen = new Set<string>();
  let nextPageUrl: string | undefined = `${AMAZON_ORDERS_URL}?opt=ab&digitalOrders=0`;

  for (
    let pageIndex = 0;
    pageIndex < MAX_ORDER_PAGES && nextPageUrl && results.length < maxLinks;
    pageIndex += 1
  ) {
    await page.goto(nextPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForTimeout(700);

    const extracted = await page.evaluate(() => {
      const toAbsolute = (href: string | null): string | undefined => {
        if (!href) return undefined;
        try {
          return new URL(href, window.location.origin).toString();
        } catch {
          return undefined;
        }
      };

      const cards = Array.from(
        document.querySelectorAll(
          "[data-order-id], .order, .order-card, .a-box-group, div.yohtmlc-order-level-card"
        )
      );

      const links: Array<{
        detailUrl: string;
        orderId?: string;
        orderDateText?: string;
      }> = [];

      const pushFromRoot = (root: Element): void => {
        const text = (root.textContent ?? "").replace(/\s+/g, " ").trim();
        const orderId = text.match(/\d{3}-\d{7}-\d{7}/)?.[0];
        const dateMatch = text.match(
          /(?:ordered on|order placed)\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i
        );
        const detailAnchor = Array.from(root.querySelectorAll("a[href]")).find(
          (anchor) => {
            const href = anchor.getAttribute("href") ?? "";
            return (
              href.includes("order-details") ||
              href.includes("orderID=") ||
              href.includes("order-history")
            );
          }
        ) as HTMLAnchorElement | undefined;
        const detailUrl = toAbsolute(detailAnchor?.getAttribute("href") ?? null);
        if (!detailUrl) {
          return;
        }
        links.push({
          detailUrl,
          orderId,
          orderDateText: dateMatch?.[1],
        });
      };

      if (cards.length > 0) {
        cards.forEach(pushFromRoot);
      } else {
        const fallbackLinks = Array.from(
          document.querySelectorAll("a[href*='order-details'], a[href*='orderID=']")
        );
        for (const anchor of fallbackLinks) {
          const detailUrl = toAbsolute(anchor.getAttribute("href"));
          if (detailUrl) {
            links.push({ detailUrl });
          }
        }
      }

      const nextAnchor = Array.from(document.querySelectorAll("a[href]")).find(
        (anchor) => {
          const text = (anchor.textContent ?? "").trim().toLowerCase();
          if (!text.includes("next")) {
            return false;
          }
          const disabledParent = anchor.closest("li.a-disabled");
          return !disabledParent;
        }
      ) as HTMLAnchorElement | undefined;

      return {
        links,
        nextPageUrl: toAbsolute(nextAnchor?.getAttribute("href") ?? null),
      };
    });

    for (const link of extracted.links) {
      if (!link.detailUrl || seen.has(link.detailUrl)) {
        continue;
      }
      seen.add(link.detailUrl);
      results.push(link);
      if (results.length >= maxLinks) {
        break;
      }
    }

    nextPageUrl = extracted.nextPageUrl ?? undefined;
  }

  return results;
}

function normalizeStatusTimestamp(timestamp: string | undefined): string {
  if (!timestamp) {
    return new Date().toISOString();
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

async function extractOrderShipments(
  page: Page,
  orderLink: AmazonOrderLink,
  timeoutMs: number
): Promise<AmazonRawShipment[]> {
  await page.goto(orderLink.detailUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForTimeout(700);

  const sourceUrl = page.url();
  const extracted = await page.evaluate(() => {
    const pageText = (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
    const orderIdFromText = pageText.match(/\d{3}-\d{7}-\d{7}/)?.[0];
    const dateMatch = pageText.match(
      /(?:ordered on|order placed)\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i
    );

    const toAbsolute = (href: string | null): string | undefined => {
      if (!href) return undefined;
      try {
        return new URL(href, window.location.origin).toString();
      } catch {
        return undefined;
      }
    };

    const itemTitles = Array.from(
      document.querySelectorAll(
        ".yohtmlc-product-title, [data-item-title], .a-truncate-cut, .a-size-base-plus"
      )
    )
      .map((entry) => (entry.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 10);

    const shipmentRoots = Array.from(
      document.querySelectorAll(
        "[data-shipment-id], .shipment, .track-package-container, div.a-box-group"
      )
    );
    const roots = shipmentRoots.length > 0 ? shipmentRoots : [document.body];

    const shipments = roots.map((root, index) => {
      const rootText = (root.textContent ?? "").replace(/\s+/g, " ").trim();
      const trackingAnchor = Array.from(root.querySelectorAll("a[href]")).find(
        (anchor) => {
          const text = (anchor.textContent ?? "").toLowerCase();
          const href = (anchor.getAttribute("href") ?? "").toLowerCase();
          return (
            text.includes("track package") ||
            text.includes("track shipment") ||
            href.includes("progress-tracker") ||
            href.includes("track")
          );
        }
      ) as HTMLAnchorElement | undefined;
      const invoiceAnchor = Array.from(root.querySelectorAll("a[href]")).find(
        (anchor) => {
          const text = (anchor.textContent ?? "").toLowerCase();
          const href = (anchor.getAttribute("href") ?? "").toLowerCase();
          return (
            text.includes("invoice") ||
            text.includes("order summary") ||
            href.includes("invoice") ||
            href.includes("order-summary")
          );
        }
      ) as HTMLAnchorElement | undefined;

      const statusText =
        (root.querySelector(
          ".yohtmlc-shipment-status, [data-shipment-status], .a-color-success, .a-color-state"
        )?.textContent ?? rootText)
          .replace(/\s+/g, " ")
          .trim() || "Tracking update available";
      const delivered = /delivered/i.test(statusText) || /delivered/i.test(rootText);

      const timestampMatch = rootText.match(
        /([A-Za-z]+\s+\d{1,2},\s+\d{4}(?:\s+\d{1,2}:\d{2}\s*[AP]M)?)/
      );
      const trackingMatch = rootText.match(
        /\b(1Z[0-9A-Z]{16}|9[0-9]{20,30}|TBA[0-9A-Z]+|[A-Z]{2}[0-9]{9}[A-Z]{2}|[A-Z0-9]{10,30})\b/
      );
      const shipmentId =
        (root as HTMLElement).dataset?.shipmentId ||
        `${orderIdFromText ?? "order"}-${index + 1}`;

      const eventNodes = Array.from(
        root.querySelectorAll("li, .a-list-item, [data-event], .track-event")
      ).slice(0, 6);
      const events: Array<{ description: string; timestamp?: string }> = [];
      for (const eventNode of eventNodes) {
        const text = (eventNode.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!text) {
          continue;
        }
        const dateText = text.match(
          /([A-Za-z]+\s+\d{1,2},\s+\d{4}(?:\s+\d{1,2}:\d{2}\s*[AP]M)?)/
        )?.[1];
        events.push({
          description: text,
          timestamp: dateText,
        });
      }

      if (events.length === 0) {
        events.push({
          description: statusText,
          timestamp: timestampMatch?.[1],
        });
      }

      return {
        shipmentId,
        orderId: orderIdFromText,
        orderDateText: dateMatch?.[1],
        status: {
          description: statusText,
          timestamp: timestampMatch?.[1],
        },
        trackingNumber: trackingMatch?.[1],
        trackingUrl: toAbsolute(trackingAnchor?.getAttribute("href") ?? null),
        invoiceUrl: toAbsolute(invoiceAnchor?.getAttribute("href") ?? null),
        estimatedDelivery: rootText.match(
          /(?:arriving|delivery date|expected by)\s*([A-Za-z]+\s+\d{1,2}(?:,\s+\d{4})?)/i
        )?.[1],
        carrierHint: rootText,
        delivered,
        events,
      };
    });

    return {
      sourceUrl: window.location.href,
      orderId: orderIdFromText,
      orderDateText: dateMatch?.[1],
      itemTitles,
      shipments,
    };
  });

  return extracted.shipments.map((shipment) => ({
    ...shipment,
    orderId: shipment.orderId ?? extracted.orderId ?? orderLink.orderId,
    orderDateText:
      shipment.orderDateText ?? extracted.orderDateText ?? orderLink.orderDateText,
    sourceUrl,
    itemTitles:
      extracted.itemTitles.length > 0
        ? extracted.itemTitles
        : ["Amazon order item"],
  }));
}

async function generateInvoicePdfBase64(
  context: BrowserContext,
  sourceUrl: string,
  timeoutMs: number
): Promise<string | undefined> {
  const page = await context.newPage();
  try {
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForTimeout(600);
    const buffer = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: {
        top: "0.4in",
        bottom: "0.4in",
        left: "0.4in",
        right: "0.4in",
      },
    });
    return buffer.toString("base64");
  } catch {
    return undefined;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function scrapeShipments(
  page: Page,
  context: BrowserContext,
  config: NormalizedImportConfig
): Promise<AmazonImportedShipment[]> {
  await ensureOrdersPage(page, config.timeoutMs);
  const toInspect = Math.max(config.maxShipments * 3, config.maxShipments);
  const orderLinks = await collectOrderLinks(page, toInspect, config.timeoutMs);
  const cutoff = Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000;
  const nowIso = new Date().toISOString();
  const shipments: AmazonImportedShipment[] = [];
  const pdfCache = new Map<string, string | undefined>();

  for (const orderLink of orderLinks) {
    if (shipments.length >= config.maxShipments) {
      break;
    }

    const rawShipments = await extractOrderShipments(page, orderLink, config.timeoutMs);
    for (const raw of rawShipments) {
      if (shipments.length >= config.maxShipments) {
        break;
      }

      const orderId = raw.orderId ?? orderLink.orderId ?? "unknown-order";
      const shipmentId = raw.shipmentId ?? `${orderId}-1`;
      const orderDate = parseAmazonDate(raw.orderDateText);
      if (orderDate && orderDate.getTime() < cutoff) {
        continue;
      }

      if (raw.delivered && config.archiveDelivered) {
        continue;
      }

      const statusDescription =
        compact(raw.status?.description) ?? "Tracking update available";
      const statusCode = resolveStatusCode(statusDescription, raw.delivered);
      const carrier = resolveCarrierName(raw.carrierHint);
      const trackingNumber = compact(raw.trackingNumber) ?? `${orderId}-${shipmentId}`;
      const trackingUrl = compact(raw.trackingUrl) ?? raw.sourceUrl;
      const statusTimestamp = normalizeStatusTimestamp(raw.status?.timestamp);

      const events: ShipmentStatus[] = raw.events
        .map((event) => ({
          code: resolveStatusCode(
            compact(event.description) ?? statusDescription,
            raw.delivered
          ),
          description: compact(event.description) ?? statusDescription,
          timestamp: normalizeStatusTimestamp(event.timestamp),
          location: compact(event.location),
        }))
        .slice(0, 12);

      if (events.length === 0) {
        events.push({
          code: statusCode,
          description: statusDescription,
          timestamp: statusTimestamp,
        });
      }

      const invoiceUrl = compact(raw.invoiceUrl) ?? raw.sourceUrl;
      let invoicePdfBase64: string | undefined;
      if (pdfCache.has(invoiceUrl)) {
        invoicePdfBase64 = pdfCache.get(invoiceUrl);
      } else {
        invoicePdfBase64 = await generateInvoicePdfBase64(
          context,
          invoiceUrl,
          config.timeoutMs
        );
        pdfCache.set(invoiceUrl, invoicePdfBase64);
      }

      const invoiceFilename = `amazon-${orderId}-${shipmentId}.pdf`
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .toLowerCase();

      shipments.push({
        source: "amazon",
        orderId,
        shipmentId,
        delivered: raw.delivered,
        trackingNumber,
        trackingUrl,
        carrier,
        status: {
          code: statusCode,
          description: statusDescription,
          timestamp: statusTimestamp,
          location: compact(raw.status?.location),
        },
        estimatedDelivery: compact(raw.estimatedDelivery),
        events,
        invoice: {
          filename: invoiceFilename,
          json: {
            source: "amazon",
            orderId,
            shipmentId,
            orderDate: orderDate?.toISOString(),
            status: statusDescription,
            statusCode,
            delivered: raw.delivered,
            trackingNumber,
            trackingUrl,
            carrier,
            items: raw.itemTitles,
            invoiceUrl,
            importedAt: nowIso,
          },
          pdfBase64: invoicePdfBase64,
        },
      });
    }
  }

  return shipments;
}

async function completeImport(
  page: Page,
  context: BrowserContext,
  config: NormalizedImportConfig
): Promise<AmazonImportResponse> {
  const shipments = await scrapeShipments(page, context, config);
  return {
    status: "completed",
    importedAt: new Date().toISOString(),
    lookbackDays: config.lookbackDays,
    maxShipments: config.maxShipments,
    archiveDelivered: config.archiveDelivered,
    shipments,
  };
}

export async function importAmazonShipments(
  payload: AmazonImportRequest
): Promise<AmazonImportResponse> {
  await cleanupExpiredTotpSessions();

  const challengeId = compact(payload.challengeId);
  if (challengeId) {
    const pending = pendingTotpSessions.get(challengeId);
    if (!pending) {
      throw new Error("TOTP challenge expired. Start Amazon sign-in again.");
    }

    try {
      await submitTotp(pending.page, pending.config, payload.totpCode ?? "");
      const result = await completeImport(
        pending.page,
        pending.session.context,
        pending.config
      );
      return result;
    } finally {
      pendingTotpSessions.delete(challengeId);
      await pending.session.close().catch(() => undefined);
    }
  }

  const config = normalizeImportConfig(payload);
  const session = await createBrowserSession(config.timeoutMs);
  const page = await session.context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  try {
    const alreadyAuthenticated = await hasAuthenticatedOrdersSession(
      page,
      config.timeoutMs
    );

    if (!alreadyAuthenticated) {
      const loginResult = await signInWithPassword(page, config);
      if (loginResult.needsTotp) {
        const id = randomUUID();
        const expiresAt = Date.now() + TOTP_SESSION_TTL_MS;
        pendingTotpSessions.set(id, {
          id,
          createdAt: Date.now(),
          expiresAt,
          config,
          session,
          page,
        });
        return {
          status: "totp_required",
          challengeId: id,
          expiresAt: new Date(expiresAt).toISOString(),
        };
      }
    }

    const result = await completeImport(page, session.context, config);
    await session.close();
    return result;
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}
