import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { handleRequest } from "../src/app";

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

describe("Amazon import integration", () => {
  it("proxies import requests to scraper with optional auth token", async () => {
    const server = await createMockScraperServer((req, res, body) => {
      if (req.url !== "/amazon/import" || req.method !== "POST") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      const payload = JSON.parse(body);
      expect(payload.username).toBe("user@example.com");
      expect(payload.password).toBe("pass123");
      expect(payload.maxShipments).toBe(8);
      expect(payload.lookbackDays).toBe(30);
      expect(payload.archiveDelivered).toBe(true);

      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status: "completed",
          importedAt: "2026-03-03T16:00:00.000Z",
          lookbackDays: 30,
          maxShipments: 8,
          archiveDelivered: true,
          shipments: [],
        })
      );
    });
    serversToClose.push(server.close);

    const response = await handleRequest(
      new Request("https://paqq.test/api/amazon/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "user@example.com",
          password: "pass123",
          maxShipments: 8,
          lookbackDays: 30,
          archiveDelivered: true,
        }),
      }),
      {
        AMAZON_SCRAPER_URL: server.baseUrl,
        AMAZON_SCRAPER_TOKEN: "amazon-token",
        AMAZON_SCRAPER_TIMEOUT_MS: "60000",
      }
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { status: string };
    expect(payload.status).toBe("completed");
    expect(server.requests.length).toBe(1);
    expect(server.requests[0].headers["x-amazon-scraper-token"]).toBe(
      "amazon-token"
    );
  });

  it("returns TOTP challenge responses from scraper", async () => {
    const server = await createMockScraperServer((req, res, body) => {
      if (req.url !== "/amazon/import" || req.method !== "POST") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      const payload = JSON.parse(body);
      expect(payload.challengeId).toBe("challenge-1");
      expect(payload.totpCode).toBe("123456");

      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status: "totp_required",
          challengeId: "challenge-2",
          expiresAt: "2026-03-03T16:10:00.000Z",
        })
      );
    });
    serversToClose.push(server.close);

    const response = await handleRequest(
      new Request("https://paqq.test/api/amazon/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: "challenge-1",
          totpCode: "123456",
        }),
      }),
      {
        AMAZON_SCRAPER_URL: server.baseUrl,
        AMAZON_SCRAPER_TIMEOUT_MS: "60000",
      }
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { status: string };
    expect(payload.status).toBe("totp_required");
  });

  it("validates required credential fields", async () => {
    const response = await handleRequest(
      new Request("https://paqq.test/api/amazon/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxShipments: 5 }),
      }),
      {}
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("username and password");
  });
});
