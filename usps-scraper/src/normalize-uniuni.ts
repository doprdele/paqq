import { ShipmentInfo, ShipmentStatus } from "./types.js";

export interface UniuniPathEvent {
  state?: number | string;
  code?: string;
  pathInfo?: string;
  description_en?: string;
  pathAddress?: string;
  pathAddr?: string;
  pathTime?: number | string;
  dateTime?: {
    ts?: number | string;
    localTime?: string;
  };
}

export interface UniuniValidTracking {
  tno?: string;
  state?: number | string;
  estimate_time?: string;
  spath_list?: UniuniPathEvent[];
}

export interface UniuniTrackingApiResponse {
  status?: string;
  ret_msg?: string;
  data?: {
    invalid_tno?: string;
    valid_tno?: UniuniValidTracking[];
  };
}

function compact(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toNumber(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toIsoTimestamp(value: number | string | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      return new Date(asNumber * 1000).toISOString();
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
    return trimmed;
  }

  return undefined;
}

function statusCodeFromStateOrDescription(
  state: number | undefined,
  description: string
): string {
  const lower = description.toLowerCase();

  if (state === 203 || lower.includes("delivered")) return "5";
  if (state === 202 || lower.includes("out for delivery")) return "4";
  if (
    lower.includes("in transit") ||
    lower.includes("arrived") ||
    lower.includes("ready for delivery") ||
    lower.includes("pickup")
  ) {
    return "3";
  }
  if (lower.includes("label created") || lower.includes("pre-shipment")) {
    return "2";
  }
  return "1";
}

function normalizeEvent(event: UniuniPathEvent): ShipmentStatus | null {
  const description = compact(event.description_en) ?? compact(event.pathInfo) ?? compact(event.code);
  if (!description) {
    return null;
  }

  const ts =
    toIsoTimestamp(event.dateTime?.ts) ?? toIsoTimestamp(event.pathTime);
  if (!ts) {
    return null;
  }

  const state = toNumber(event.state);
  const code = statusCodeFromStateOrDescription(state, description);
  const location = compact(event.pathAddress) ?? compact(event.pathAddr);

  return {
    code,
    description,
    timestamp: ts,
    location,
  };
}

function normalizeEstimateTime(value: string | undefined): string | undefined {
  const normalized = compact(value);
  if (!normalized) return undefined;
  return normalized;
}

export function normalizeUniuniTracking(
  trackingNumber: string,
  trackingUrl: string,
  payload: UniuniTrackingApiResponse
): ShipmentInfo {
  if (payload.status !== "SUCCESS") {
    throw new Error(payload.ret_msg || "UniUni tracking request failed");
  }

  const validTrackings = payload.data?.valid_tno;
  if (!Array.isArray(validTrackings) || validTrackings.length === 0) {
    const invalid = compact(payload.data?.invalid_tno);
    if (invalid) {
      throw new Error("UniUni has no information for this tracking number");
    }
    throw new Error("UniUni response did not include a valid tracking entry");
  }

  const matching =
    validTrackings.find(
      (entry) =>
        compact(entry.tno)?.toUpperCase() === trackingNumber.toUpperCase()
    ) ?? validTrackings[0];

  const rawEvents = Array.isArray(matching.spath_list) ? matching.spath_list : [];
  const events = rawEvents
    .map((event) => normalizeEvent(event))
    .filter((event): event is ShipmentStatus => event !== null)
    .sort((left, right) => {
      const l = Date.parse(left.timestamp);
      const r = Date.parse(right.timestamp);
      if (!Number.isNaN(l) && !Number.isNaN(r)) {
        return r - l;
      }
      return right.timestamp.localeCompare(left.timestamp);
    });

  if (events.length === 0) {
    throw new Error("UniUni response did not contain any usable events");
  }

  const latest = events[0];
  const topState = toNumber(matching.state);
  const statusCode = statusCodeFromStateOrDescription(
    topState,
    latest.description
  );

  return {
    trackingNumber: compact(matching.tno) ?? trackingNumber,
    trackingUrl,
    carrier: "uniuni",
    status: {
      code: statusCode,
      description: latest.description,
      timestamp: latest.timestamp,
      location: latest.location,
    },
    estimatedDelivery: normalizeEstimateTime(matching.estimate_time),
    events,
  };
}

export function getUniuniStatusCodeFromDescription(
  description: string,
  state?: number | string
): string {
  return statusCodeFromStateOrDescription(toNumber(state), description);
}
