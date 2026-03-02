import { ShipmentInfo, ShipmentStatus } from "./types.js";

export interface RawUspsEvent {
  code?: string;
  description?: string;
  timestamp?: string;
  location?: string;
}

export interface RawUspsTracking {
  trackingNumber: string;
  trackingUrl: string;
  statusCode?: string;
  statusDescription?: string;
  statusTimestamp?: string;
  statusLocation?: string;
  estimatedDelivery?: string;
  events: RawUspsEvent[];
}

function compact(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toIsoOrInput(value: string | undefined): string {
  const normalized = compact(value);
  if (!normalized) return new Date().toISOString();
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) return normalized;
  return new Date(parsed).toISOString();
}

function statusCodeFromDescription(description: string): string {
  const lower = description.toLowerCase();

  if (lower.includes("delivered")) return "5";
  if (lower.includes("out for delivery")) return "4";
  if (
    lower.includes("in transit") ||
    lower.includes("arrived") ||
    lower.includes("departed") ||
    lower.includes("accepted")
  ) {
    return "3";
  }
  if (lower.includes("label") || lower.includes("pre-shipment")) return "2";

  return "1";
}

function normalizeEvent(event: RawUspsEvent): ShipmentStatus | null {
  const description = compact(event.description);
  const timestamp = compact(event.timestamp);

  if (!description || !timestamp) return null;

  return {
    code: compact(event.code) ?? statusCodeFromDescription(description),
    description,
    timestamp: toIsoOrInput(timestamp),
    location: compact(event.location),
  };
}

export function normalizeUspsTracking(raw: RawUspsTracking): ShipmentInfo {
  const events = raw.events
    .map((event) => normalizeEvent(event))
    .filter((event): event is ShipmentStatus => event !== null);

  if (events.length === 0) {
    throw new Error("USPS response did not contain any usable events");
  }

  const fallbackLatest = events[0];
  const description =
    compact(raw.statusDescription) ?? compact(fallbackLatest.description) ?? "Unknown";

  const status: ShipmentStatus = {
    code:
      compact(raw.statusCode) ??
      statusCodeFromDescription(description),
    description,
    timestamp: toIsoOrInput(raw.statusTimestamp ?? fallbackLatest.timestamp),
    location: compact(raw.statusLocation) ?? compact(fallbackLatest.location),
  };

  return {
    trackingNumber: raw.trackingNumber,
    trackingUrl: raw.trackingUrl,
    carrier: "usps",
    status,
    estimatedDelivery: compact(raw.estimatedDelivery),
    events,
  };
}

export function getStatusCodeFromDescription(description: string): string {
  return statusCodeFromDescription(description);
}
