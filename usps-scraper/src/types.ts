export interface ShipmentStatus {
  code: string;
  description: string;
  timestamp: string;
  location?: string;
}

export interface ShipmentInfo {
  trackingNumber: string;
  trackingUrl: string;
  carrier: string;
  status: ShipmentStatus;
  estimatedDelivery?: string;
  events: ShipmentStatus[];
}

export interface ScrapeOptions {
  timeoutMs?: number;
}

export interface AmazonImportRequest {
  username?: string;
  password?: string;
  challengeId?: string;
  totpCode?: string;
  maxShipments?: number;
  lookbackDays?: number;
  archiveDelivered?: boolean;
  timeoutMs?: number;
}

export interface AmazonInvoicePayload {
  filename: string;
  json: Record<string, unknown>;
  pdfBase64?: string;
}

export interface AmazonImportedShipment extends ShipmentInfo {
  source: "amazon";
  orderId: string;
  shipmentId: string;
  delivered: boolean;
  invoice: AmazonInvoicePayload;
}

export interface AmazonImportCompletedResponse {
  status: "completed";
  importedAt: string;
  lookbackDays: number;
  maxShipments: number;
  archiveDelivered: boolean;
  shipments: AmazonImportedShipment[];
}

export interface AmazonImportTotpRequiredResponse {
  status: "totp_required";
  challengeId: string;
  expiresAt: string;
}

export type AmazonImportResponse =
  | AmazonImportCompletedResponse
  | AmazonImportTotpRequiredResponse;
