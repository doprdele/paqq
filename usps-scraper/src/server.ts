import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { scrapeUspsTracking } from "./scrape.js";
import { scrapeUniuniTracking } from "./uniuni.js";

const port = Number(process.env.PORT ?? "8790");
const TRACKING_ROUTES = new Set(["/track", "/track/usps", "/track/uniuni"]);

function jsonResponse(
  res: ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function unauthorized(res: ServerResponse): void {
  jsonResponse(res, 401, { error: "Unauthorized" });
}

function getHeaderToken(
  req: IncomingMessage,
  headerName: string
): string | undefined {
  const providedToken = req.headers[headerName];
  if (Array.isArray(providedToken)) {
    return providedToken[0];
  }
  return providedToken;
}

function ensureAuthToken(
  req: IncomingMessage,
  res: ServerResponse,
  envToken: string | undefined,
  headerName: string
): boolean {
  if (!envToken) {
    return true;
  }
  const provided = getHeaderToken(req, headerName);
  if (provided !== envToken) {
    unauthorized(res);
    return false;
  }
  return true;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return jsonResponse(res, 200, { ok: true });
    }

    if (
      req.method !== "POST" ||
      !req.url ||
      !TRACKING_ROUTES.has(req.url)
    ) {
      return jsonResponse(res, 404, { error: "Not found" });
    }

    const route =
      req.url === "/track" || req.url === "/track/usps" ? "usps" : "uniuni";

    if (route === "usps") {
      const isAuthorized = ensureAuthToken(
        req,
        res,
        process.env.USPS_SCRAPER_TOKEN,
        "x-usps-scraper-token"
      );
      if (!isAuthorized) {
        return;
      }
    } else {
      const isAuthorized = ensureAuthToken(
        req,
        res,
        process.env.UNIUNI_SCRAPER_TOKEN,
        "x-uniuni-scraper-token"
      );
      if (!isAuthorized) {
        return;
      }
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
    const trackingNumber = typeof body.trackingNumber === "string" ? body.trackingNumber : "";
    const timeoutMs =
      typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
        ? body.timeoutMs
        : undefined;

    if (!trackingNumber) {
      return jsonResponse(res, 400, { error: "trackingNumber is required" });
    }

    const shipment =
      route === "usps"
        ? await scrapeUspsTracking(trackingNumber, { timeoutMs })
        : await scrapeUniuniTracking(trackingNumber, { timeoutMs });
    return jsonResponse(res, 200, shipment);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected scraper error";
    return jsonResponse(res, 500, { error: message });
  }
});

server.listen(port, () => {
  process.stdout.write(`Packt scraper service listening on port ${port}\n`);
});
