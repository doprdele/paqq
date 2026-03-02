import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: CapturedRequest[];
}> {
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

describe("UniUni source integration", () => {
  it("includes UniUni in /api/list", async () => {
    sourcesRegistry.initialize({ UNIUNI_SCRAPER_URL: "http://127.0.0.1:8790" });

    const response = await handleList(new Request("https://packt.test/api/list"));
    const sources = (await response.json()) as Array<{
      name: string;
      requiredFields: string[];
      icon?: string;
    }>;

    const uniuni = sources.find((source) => source.name === "uniuni");

    expect(uniuni).toBeDefined();
    expect(uniuni?.requiredFields).toEqual(["trackingNumber"]);
    expect(uniuni?.icon).toBe("uniuni.png");
  });

  it("retrieves UniUni tracking via configured scraper service", async () => {
    const server = await createMockScraperServer((req, res, body) => {
      if (req.url !== "/track/uniuni" || req.method !== "POST") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          trackingNumber: "UUS62M6610133301160",
          trackingUrl: "https://www.uniuni.com/tracking/",
          carrier: "uniuni",
          status: {
            code: "5",
            description: "Your Parcel has been delivered",
            timestamp: "2026-02-26T19:22:04.000Z",
            location: "Belmont MA",
          },
          estimatedDelivery: "2026-02-27",
          events: [
            {
              code: "5",
              description: "Your Parcel has been delivered",
              timestamp: "2026-02-26T19:22:04.000Z",
              location: "Belmont MA",
            },
          ],
        })
      );

      const parsed = JSON.parse(body);
      expect(parsed.trackingNumber).toBe("UUS62M6610133301160");
      expect(parsed.timeoutMs).toBe(45000);
    });

    serversToClose.push(server.close);

    const env = {
      UNIUNI_SCRAPER_URL: server.baseUrl,
      UNIUNI_SCRAPER_TOKEN: "uniuni-token",
      UNIUNI_SCRAPER_TIMEOUT_MS: "45000",
    };
    sourcesRegistry.initialize(env);

    const response = await handleGet(
      new Request(
        "https://packt.test/api/get?source=uniuni&trackingNumber=UUS62M6610133301160"
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

    expect(shipment.carrier).toBe("uniuni");
    expect(shipment.trackingNumber).toBe("UUS62M6610133301160");
    expect(shipment.status.description).toContain("delivered");
    expect(shipment.events.length).toBeGreaterThan(0);

    expect(server.requests.length).toBe(1);
    expect(server.requests[0].headers["x-uniuni-scraper-token"]).toBe(
      "uniuni-token"
    );
  });

  it("uses default UniUni scraper timeout when not configured", async () => {
    const server = await createMockScraperServer((req, res, body) => {
      if (req.url !== "/track/uniuni" || req.method !== "POST") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      const parsed = JSON.parse(body);
      expect(parsed.timeoutMs).toBe(300000);

      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          trackingNumber: "UUS62M6610133301160",
          trackingUrl: "https://www.uniuni.com/tracking/",
          carrier: "uniuni",
          status: {
            code: "3",
            description: "Parcel in transit",
            timestamp: "2026-02-24T21:13:43.000Z",
            location: "Carlstadt NJ",
          },
          events: [
            {
              code: "3",
              description: "Parcel in transit",
              timestamp: "2026-02-24T21:13:43.000Z",
              location: "Carlstadt NJ",
            },
          ],
        })
      );
    });

    serversToClose.push(server.close);

    const env = {
      UNIUNI_SCRAPER_URL: server.baseUrl,
    };
    sourcesRegistry.initialize(env);

    const response = await handleGet(
      new Request(
        "https://packt.test/api/get?source=uniuni&trackingNumber=UUS62M6610133301160"
      ),
      env
    );

    expect(response.status).toBe(200);
  });

  it("returns backend error when UniUni scraper fails", async () => {
    const server = await createMockScraperServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "UniUni blocked this request" }));
    });

    serversToClose.push(server.close);

    const env = {
      UNIUNI_SCRAPER_URL: server.baseUrl,
      UNIUNI_SCRAPER_TIMEOUT_MS: "60000",
    };

    sourcesRegistry.initialize(env);

    const response = await handleGet(
      new Request(
        "https://packt.test/api/get?source=uniuni&trackingNumber=UUS62M6610133301160"
      ),
      env
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("UniUni blocked this request");
  });
});
