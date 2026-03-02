import { describe, expect, it } from "vitest";
import { handleGet } from "../src/handlers/get";
import { sourcesRegistry } from "../src/sources";

const liveEnabled = process.env.RUN_LIVE_UNIUNI_BACKEND_TESTS === "1";
const liveTrackingNumber =
  process.env.UNIUNI_LIVE_TRACKING_NUMBER ?? "UUS62M6610133301160";
const liveScraperUrl = process.env.UNIUNI_SCRAPER_URL ?? "http://127.0.0.1:8790";

(liveEnabled ? describe : describe.skip)(
  "live UniUni backend integration",
  () => {
    it(
      "retrieves real UniUni tracking through Packt backend source",
      async () => {
        const env = {
          UNIUNI_SCRAPER_URL: liveScraperUrl,
          UNIUNI_SCRAPER_TIMEOUT_MS: "60000",
          UNIUNI_SCRAPER_TOKEN: process.env.UNIUNI_SCRAPER_TOKEN ?? "",
        };
        sourcesRegistry.initialize(env);

        const response = await handleGet(
          new Request(
            `https://packt.test/api/get?source=uniuni&trackingNumber=${encodeURIComponent(
              liveTrackingNumber
            )}`
          ),
          env
        );

        expect(response.status).toBe(200);
        const payload = (await response.json()) as {
          carrier: string;
          trackingNumber: string;
          status: { description: string };
          events: Array<{ description: string }>;
        };

        expect(payload.carrier).toBe("uniuni");
        expect(payload.trackingNumber).toContain(liveTrackingNumber.slice(0, 8));
        expect(payload.status.description.length).toBeGreaterThan(3);
        expect(payload.events.length).toBeGreaterThan(0);
      },
      300_000
    );
  }
);
