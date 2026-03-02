import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrackingScheduler } from "../src/scheduler";

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface MockServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

async function createMockScraperServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
    requests: CapturedRequest[]
  ) => Promise<void> | void
): Promise<MockServer> {
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
      body,
    });
    await handler(req, res, body, requests);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (task) {
      await task();
    }
  }
});

describe("TrackingScheduler", () => {
  it("polls UniUni targets through the scheduler", async () => {
    const server = await createMockScraperServer((req, res) => {
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
    cleanupTasks.push(server.close);

    const stateDir = await mkdtemp(join(tmpdir(), "packt-scheduler-test-"));
    const stateFile = join(stateDir, "scheduler-uniuni.json");
    cleanupTasks.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const scheduler = new TrackingScheduler({
      UNIUNI_SCRAPER_URL: server.baseUrl,
      PACKT_TRACKING_SCHEDULER_ENABLED: "true",
      PACKT_TRACKING_SCHEDULER_INTERVAL_MS: "14400000",
      PACKT_TRACKING_SCHEDULER_STATE_FILE: stateFile,
      PACKT_TRACKING_SCHEDULER_RUN_ON_START: "false",
    });
    cleanupTasks.push(async () => scheduler.stop());

    await scheduler.start();
    await scheduler.registerTarget("uniuni", {
      trackingNumber: "UUS62M6610133301160",
    });
    await scheduler.runNow({ force: true });

    expect(server.requests.length).toBe(1);
    expect(server.requests[0].url).toBe("/track/uniuni");

    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as {
      watchedTargets: Record<string, unknown>;
    };
    expect(Object.keys(persisted.watchedTargets).length).toBe(1);
  });

  it("serializes runs so only one run executes at a time", async () => {
    const server = await createMockScraperServer(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          trackingNumber: "9400150208203004850386",
          trackingUrl:
            "https://tools.usps.com/go/TrackConfirmAction.action?tLabels=9400150208203004850386",
          carrier: "usps",
          status: {
            code: "3",
            description: "In Transit",
            timestamp: "2026-02-28T22:19:00.000Z",
            location: "TEST CITY, ST 00000",
          },
          events: [
            {
              code: "3",
              description: "In Transit",
              timestamp: "2026-02-28T22:19:00.000Z",
              location: "TEST CITY, ST 00000",
            },
          ],
        })
      );
    });
    cleanupTasks.push(server.close);

    const stateDir = await mkdtemp(join(tmpdir(), "packt-scheduler-test-"));
    cleanupTasks.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const scheduler = new TrackingScheduler({
      USPS_SCRAPER_URL: server.baseUrl,
      PACKT_TRACKING_SCHEDULER_ENABLED: "true",
      PACKT_TRACKING_SCHEDULER_INTERVAL_MS: "3600000",
      PACKT_TRACKING_SCHEDULER_STATE_FILE: join(stateDir, "scheduler.json"),
      PACKT_TRACKING_SCHEDULER_RUN_ON_START: "false",
    });
    cleanupTasks.push(async () => scheduler.stop());

    await scheduler.start();
    await scheduler.registerTarget("usps", {
      trackingNumber: "9400150208203004850386",
    });

    const [runA, runB] = await Promise.all([
      scheduler.runNow({ force: true }),
      scheduler.runNow({ force: true }),
    ]);

    expect([runA, runB].filter(Boolean).length).toBe(1);
    expect(server.requests.length).toBe(1);
  });

  it("persists watched targets and status", async () => {
    const server = await createMockScraperServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          trackingNumber: "9400150208203004850386",
          trackingUrl:
            "https://tools.usps.com/go/TrackConfirmAction.action?tLabels=9400150208203004850386",
          carrier: "usps",
          status: {
            code: "5",
            description: "Delivered",
            timestamp: "2026-02-28T22:19:00.000Z",
            location: "TEST CITY, ST 00000",
          },
          events: [
            {
              code: "5",
              description: "Delivered",
              timestamp: "2026-02-28T22:19:00.000Z",
              location: "TEST CITY, ST 00000",
            },
          ],
        })
      );
    });
    cleanupTasks.push(server.close);

    const stateDir = await mkdtemp(join(tmpdir(), "packt-scheduler-test-"));
    const stateFile = join(stateDir, "scheduler.json");
    cleanupTasks.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const scheduler = new TrackingScheduler({
      USPS_SCRAPER_URL: server.baseUrl,
      PACKT_TRACKING_SCHEDULER_ENABLED: "true",
      PACKT_TRACKING_SCHEDULER_INTERVAL_MS: "14400000",
      PACKT_TRACKING_SCHEDULER_STATE_FILE: stateFile,
      PACKT_TRACKING_SCHEDULER_RUN_ON_START: "false",
    });
    cleanupTasks.push(async () => scheduler.stop());

    await scheduler.start();
    await scheduler.registerTarget("usps", {
      trackingNumber: "9400150208203004850386",
    });
    await scheduler.runNow({ force: true });

    const status = scheduler.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.intervalMs).toBe(14400000);
    expect(status.watchedCount).toBe(1);
    expect(status.running).toBe(false);

    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as {
      watchedTargets: Record<string, unknown>;
    };
    expect(Object.keys(persisted.watchedTargets).length).toBe(1);
  });
});
