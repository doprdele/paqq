import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { handleGet } from "../src/handlers/get";
import { handleList } from "../src/handlers/list";
import { sourcesRegistry } from "../src/sources";

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

async function createMockScraperServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
    requests: CapturedRequest[]
  ) => void
): Promise<{ baseUrl: string; close: () => Promise<void>; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
    });

    handler(req, res, body, requests);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

const serversToClose: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (serversToClose.length > 0) {
    const close = serversToClose.pop();
    if (close) {
      await close();
    }
  }
});

describe("USPS source integration", () => {
  it("includes USPS in /api/list", async () => {
    sourcesRegistry.initialize({ USPS_SCRAPER_URL: "http://127.0.0.1:8790" });

    const response = await handleList(new Request("https://packt.test/api/list"));
    const sources = (await response.json()) as Array<{
      name: string;
      requiredFields: string[];
      icon?: string;
    }>;

    const usps = sources.find((source) => source.name === "usps");

    expect(usps).toBeDefined();
    expect(usps?.requiredFields).toEqual(["trackingNumber"]);
    expect(usps?.icon).toBe("usps.png");
  });

  it("retrieves USPS tracking via configured scraper service", async () => {
    const server = await createMockScraperServer((req, res, body) => {
      if (req.url !== "/track" || req.method !== "POST") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          trackingNumber: "9400150208203004850386",
          trackingUrl:
            "https://tools.usps.com/go/TrackConfirmAction.action?tLabels=9400150208203004850386",
          carrier: "usps",
          status: {
            code: "5",
            description: "Delivered, Front Door/Porch",
            timestamp: "2026-02-28T22:19:00.000Z",
            location: "TEST CITY, ST 00000",
          },
          events: [
            {
              code: "5",
              description: "Delivered, Front Door/Porch",
              timestamp: "2026-02-28T22:19:00.000Z",
              location: "TEST CITY, ST 00000",
            },
          ],
        })
      );

      const parsed = JSON.parse(body);
      expect(parsed.trackingNumber).toBe("9400150208203004850386");
      expect(parsed.timeoutMs).toBe(60000);
    });

    serversToClose.push(server.close);

    const env = {
      USPS_SCRAPER_URL: server.baseUrl,
      USPS_SCRAPER_TOKEN: "stub-header-value",
      USPS_SCRAPER_TIMEOUT_MS: "60000",
    };
    sourcesRegistry.initialize(env);

    const response = await handleGet(
      new Request(
        "https://packt.test/api/get?source=usps&trackingNumber=9400150208203004850386"
      ),
      env
    );

    expect(response.status).toBe(200);
    const shipment = (await response.json()) as {
      carrier: string;
      trackingNumber: string;
      status: { description: string };
      events: Array<{ description: string }>;
    };

    expect(shipment.carrier).toBe("usps");
    expect(shipment.trackingNumber).toBe("9400150208203004850386");
    expect(shipment.status.description).toContain("Delivered");
    expect(shipment.events.length).toBeGreaterThan(0);

    expect(server.requests.length).toBe(1);
    expect(server.requests[0].headers["x-usps-scraper-token"]).toBe(
      "stub-header-value"
    );
  });

  it("returns backend error when USPS scraper fails", async () => {
    const server = await createMockScraperServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "USPS blocked this request" }));
    });

    serversToClose.push(server.close);

    const env = {
      USPS_SCRAPER_URL: server.baseUrl,
      USPS_SCRAPER_TIMEOUT_MS: "60000",
    };

    sourcesRegistry.initialize(env);

    const response = await handleGet(
      new Request(
        "https://packt.test/api/get?source=usps&trackingNumber=9400150208203004850386"
      ),
      env
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("USPS blocked this request");
  });
});
