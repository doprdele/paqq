import { describe, expect, it } from "vitest";
import { scrapeUniuniTracking } from "../src/uniuni.js";

const liveEnabled = process.env.RUN_LIVE_UNIUNI_TESTS === "1";
const liveTrackingNumber =
  process.env.UNIUNI_LIVE_TRACKING_NUMBER ?? "UUS62M6610133301160";

(liveEnabled ? describe : describe.skip)("live UniUni integration", () => {
  it(
    "retrieves real UniUni tracking data",
    async () => {
      let result:
        | Awaited<ReturnType<typeof scrapeUniuniTracking>>
        | undefined;
      let lastError: unknown;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          result = await scrapeUniuniTracking(liveTrackingNumber, {
            timeoutMs: 45_000,
          });
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          }
        }
      }

      if (!result) {
        throw lastError;
      }

      expect(result.carrier).toBe("uniuni");
      expect(result.trackingNumber).toContain(liveTrackingNumber.slice(0, 8));
      expect(result.trackingUrl).toContain("uniuni.com/tracking");
      expect(result.status.description.length).toBeGreaterThan(3);
      expect(result.events.length).toBeGreaterThan(0);

      for (const event of result.events) {
        expect(event.description.length).toBeGreaterThan(0);
        expect(event.timestamp.length).toBeGreaterThan(0);
      }
    },
    300_000
  );
});
