import { describe, expect, it } from "vitest";
import { scrapeUspsTracking } from "../src/scrape.js";

const liveEnabled = process.env.RUN_LIVE_USPS_TESTS === "1";
const liveTrackingNumber =
  process.env.USPS_LIVE_TRACKING_NUMBER ?? "9400150208203004850386";

(liveEnabled ? describe : describe.skip)(
  "live USPS integration",
  () => {
    it(
      "retrieves real USPS tracking data",
      async () => {
        let result:
          | Awaited<ReturnType<typeof scrapeUspsTracking>>
          | undefined;
        let lastError: unknown;

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            result = await scrapeUspsTracking(liveTrackingNumber, {
              timeoutMs: 45_000,
            });
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 3) {
              await new Promise((resolve) =>
                setTimeout(resolve, 1000 * attempt)
              );
            }
          }
        }

        if (!result) {
          throw lastError;
        }

        expect(result.carrier).toBe("usps");
        expect(result.trackingNumber).toContain(liveTrackingNumber.slice(0, 10));
        expect(result.trackingUrl).toContain("TrackConfirmAction");
        expect(result.status.description.length).toBeGreaterThan(3);
        expect(result.events.length).toBeGreaterThan(0);

        for (const event of result.events) {
          expect(event.description.length).toBeGreaterThan(0);
          expect(event.timestamp.length).toBeGreaterThan(0);
        }
      },
      300_000
    );
  }
);
