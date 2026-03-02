import { describe, expect, it } from "vitest";
import {
  getUniuniStatusCodeFromDescription,
  normalizeUniuniTracking,
  type UniuniTrackingApiResponse,
} from "../src/normalize-uniuni.js";

describe("normalizeUniuniTracking", () => {
  it("maps UniUni tracking payload into Packt shipment shape", () => {
    const raw: UniuniTrackingApiResponse = {
      status: "SUCCESS",
      ret_msg: "",
      data: {
        valid_tno: [
          {
            tno: "UUS62M6610133301160",
            state: 203,
            estimate_time: "2026-02-27",
            spath_list: [
              {
                state: 202,
                pathInfo: "Out for delivery",
                pathAddress: "Belmont MA",
                dateTime: { ts: 1772106462 },
              },
              {
                state: 203,
                description_en: "Your Parcel has been delivered",
                pathAddress: "Belmont MA",
                dateTime: { ts: 1772133724 },
              },
            ],
          },
        ],
      },
    };

    const result = normalizeUniuniTracking(
      "UUS62M6610133301160",
      "https://www.uniuni.com/tracking/",
      raw
    );

    expect(result.carrier).toBe("uniuni");
    expect(result.trackingNumber).toBe("UUS62M6610133301160");
    expect(result.status.code).toBe("5");
    expect(result.status.description).toContain("delivered");
    expect(result.estimatedDelivery).toBe("2026-02-27");
    expect(result.events).toHaveLength(2);
    expect(result.events[0].timestamp).toMatch(/2026-02-26T/);
  });

  it("throws when there are no usable events", () => {
    const raw: UniuniTrackingApiResponse = {
      status: "SUCCESS",
      data: {
        valid_tno: [
          {
            tno: "UUS62M6610133301160",
            spath_list: [],
          },
        ],
      },
    };

    expect(() =>
      normalizeUniuniTracking(
        "UUS62M6610133301160",
        "https://www.uniuni.com/tracking/",
        raw
      )
    ).toThrow("UniUni response did not contain any usable events");
  });

  it("throws when UniUni reports no info for a tracking number", () => {
    const raw: UniuniTrackingApiResponse = {
      status: "SUCCESS",
      data: {
        invalid_tno: "UUS62M6610133301160",
        valid_tno: [],
      },
    };

    expect(() =>
      normalizeUniuniTracking(
        "UUS62M6610133301160",
        "https://www.uniuni.com/tracking/",
        raw
      )
    ).toThrow("UniUni has no information for this tracking number");
  });
});

describe("getUniuniStatusCodeFromDescription", () => {
  it("maps delivered status to 5", () => {
    expect(
      getUniuniStatusCodeFromDescription("Your Parcel has been delivered", 203)
    ).toBe("5");
  });

  it("maps out-for-delivery status to 4", () => {
    expect(
      getUniuniStatusCodeFromDescription("Out for delivery", 202)
    ).toBe("4");
  });

  it("maps in-transit status to 3", () => {
    expect(
      getUniuniStatusCodeFromDescription(
        "Parcel in transit to local UniUni delivery facility",
        195
      )
    ).toBe("3");
  });

  it("maps label-created status to 2", () => {
    expect(getUniuniStatusCodeFromDescription("Label Created", 190)).toBe("2");
  });
});
