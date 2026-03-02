import { createServer, type ServerResponse } from "node:http";
import { scrapeUspsTracking } from "./scrape.js";

const port = Number(process.env.PORT ?? "8790");

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

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return jsonResponse(res, 200, { ok: true });
    }

    if (req.method !== "POST" || req.url !== "/track") {
      return jsonResponse(res, 404, { error: "Not found" });
    }

    const expectedToken = process.env.USPS_SCRAPER_TOKEN;
    if (expectedToken) {
      const providedToken = req.headers["x-usps-scraper-token"];
      const normalizedProvidedToken = Array.isArray(providedToken)
        ? providedToken[0]
        : providedToken;

      if (normalizedProvidedToken !== expectedToken) {
        return unauthorized(res);
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

    const shipment = await scrapeUspsTracking(trackingNumber, { timeoutMs });
    return jsonResponse(res, 200, shipment);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected USPS scraper error";
    return jsonResponse(res, 500, { error: message });
  }
});

server.listen(port, () => {
  process.stdout.write(`USPS scraper listening on port ${port}\n`);
});
