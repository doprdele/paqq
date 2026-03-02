import { describe, expect, it } from "vitest";
import {
  getStatusCodeFromDescription,
  normalizeUspsTracking,
  type RawUspsTracking,
} from "../src/normalize.js";

describe("normalizeUspsTracking", () => {
  it("maps USPS-style raw events into Packt shipment shape", () => {
    const raw: RawUspsTracking = {
      trackingNumber: "9400150208203004850386",
      trackingUrl:
        "https://tools.usps.com/go/TrackConfirmAction.action?tLabels=9400150208203004850386",
      statusDescription: "Delivered, Front Door/Porch",
      statusTimestamp: "February 28, 2026, 5:19 pm",
      statusLocation: "TEST CITY, ST 00000",
      events: [
        {
          description: "Delivered, Front Door/Porch",
          timestamp: "February 28, 2026, 5:19 pm",
          location: "TEST CITY, ST 00000",
          code: "Delivered",
        },
        {
          description: "Out for Delivery",
          timestamp: "February 28, 2026, 6:10 am",
          location: "TEST CITY, ST 00000",
        },
      ],
    };

    const result = normalizeUspsTracking(raw);

    expect(result.carrier).toBe("usps");
    expect(result.trackingNumber).toBe(raw.trackingNumber);
    expect(result.status.description).toBe("Delivered, Front Door/Porch");
    expect(result.status.code).toBe("5");
    expect(result.events).toHaveLength(2);
    expect(result.events[0].timestamp).toMatch(/2026-02-28T/);
  });

  it("throws when there are no usable events", () => {
    const raw: RawUspsTracking = {
      trackingNumber: "9400150208203004850386",
      trackingUrl: "https://tools.usps.com/go/TrackConfirmAction.action?tLabels=1",
      events: [],
    };

    expect(() => normalizeUspsTracking(raw)).toThrow(
      "USPS response did not contain any usable events"
    );
  });
});

describe("getStatusCodeFromDescription", () => {
  it("classifies delivered status", () => {
    expect(getStatusCodeFromDescription("Delivered, Front Door/Porch")).toBe(
      "5"
    );
  });

  it("classifies out-for-delivery status", () => {
    expect(getStatusCodeFromDescription("Out for Delivery")).toBe("4");
  });

  it("classifies in-transit status", () => {
    expect(getStatusCodeFromDescription("Arrived at USPS Facility")).toBe("3");
  });

  it("classifies pre-shipment status", () => {
    expect(
      getStatusCodeFromDescription("Shipping Label Created, USPS Awaiting Item")
    ).toBe("2");
  });
});
