export interface NotificationSettings {
  enabled: boolean;
  appriseUrls: string[];
  notifyOnStatusChange: boolean;
  notifyOnDelivered: boolean;
}

export interface CarrierCredentialField {
  key: string;
  label: string;
  envKey: string;
  secret?: boolean;
  placeholder?: string;
}

export interface CarrierCredentialSchema {
  carrier: string;
  title: string;
  description?: string;
  fields: CarrierCredentialField[];
}

export interface PaqqSettings {
  version: 1;
  notifications: NotificationSettings;
  carriers: Record<string, Record<string, string>>;
}

export type RuntimeEnv = Record<string, string | undefined>;

export const CARRIER_CREDENTIAL_SCHEMAS: CarrierCredentialSchema[] = [
  {
    carrier: "asendia",
    title: "Asendia",
    fields: [
      {
        key: "authorizationBasic",
        label: "Authorization (Basic)",
        envKey: "A1_API_KEY",
        secret: true,
      },
    ],
  },
  {
    carrier: "mondialrelay",
    title: "Mondial Relay",
    fields: [
      {
        key: "requestVerificationToken",
        label: "Request Verification Token",
        envKey: "MR_API_KEY",
        secret: true,
      },
    ],
  },
  {
    carrier: "laposte",
    title: "La Poste / Colissimo / Chronopost",
    fields: [
      {
        key: "okapiKey",
        label: "X-Okapi-Key",
        envKey: "LAPOSTE_API_KEY",
        secret: true,
      },
    ],
  },
  {
    carrier: "dhl",
    title: "DHL",
    fields: [
      {
        key: "apiKey",
        label: "DHL API Key",
        envKey: "DHL_API_KEY",
        secret: true,
      },
    ],
  },
  {
    carrier: "fedex",
    title: "FedEx",
    fields: [
      {
        key: "clientId",
        label: "Client ID",
        envKey: "FEDEX_API_KEY",
        secret: true,
      },
      {
        key: "clientSecret",
        label: "Client Secret",
        envKey: "FEDEX_SECRET_KEY",
        secret: true,
      },
    ],
  },
  {
    carrier: "ups",
    title: "UPS Scraper",
    description: "Optional token for securing scraper requests.",
    fields: [
      {
        key: "scraperToken",
        label: "UPS scraper token",
        envKey: "UPS_SCRAPER_TOKEN",
        secret: true,
      },
    ],
  },
  {
    carrier: "amazon",
    title: "Amazon Scraper",
    description: "Optional token for securing Amazon import scraper requests.",
    fields: [
      {
        key: "scraperToken",
        label: "Amazon scraper token",
        envKey: "AMAZON_SCRAPER_TOKEN",
        secret: true,
      },
    ],
  },
];

const CARRIER_SCHEMA_BY_NAME = new Map(
  CARRIER_CREDENTIAL_SCHEMAS.map((schema) => [schema.carrier, schema] as const)
);

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeAppriseUrls(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value
    .map((entry) => normalizeNonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function cloneSettings(settings: PaqqSettings): PaqqSettings {
  return {
    version: 1,
    notifications: {
      enabled: settings.notifications.enabled,
      appriseUrls: [...settings.notifications.appriseUrls],
      notifyOnStatusChange: settings.notifications.notifyOnStatusChange,
      notifyOnDelivered: settings.notifications.notifyOnDelivered,
    },
    carriers: Object.fromEntries(
      Object.entries(settings.carriers).map(([carrier, values]) => [
        carrier,
        { ...values },
      ])
    ),
  };
}

export function defaultPaqqSettings(): PaqqSettings {
  return {
    version: 1,
    notifications: {
      enabled: false,
      appriseUrls: [],
      notifyOnStatusChange: true,
      notifyOnDelivered: true,
    },
    carriers: {},
  };
}

export function parsePersistedSettings(raw: unknown): PaqqSettings {
  const defaults = defaultPaqqSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }
  return applySettingsPatch(defaults, raw);
}

export function applySettingsPatch(
  current: PaqqSettings,
  patch: unknown
): PaqqSettings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Settings payload must be an object");
  }

  const payload = patch as Record<string, unknown>;
  const next = cloneSettings(current);

  if (typeof payload.notifications !== "undefined") {
    if (
      !payload.notifications ||
      typeof payload.notifications !== "object" ||
      Array.isArray(payload.notifications)
    ) {
      throw new Error("notifications must be an object");
    }

    const notifications = payload.notifications as Record<string, unknown>;
    next.notifications = {
      enabled: normalizeBoolean(
        notifications.enabled,
        next.notifications.enabled
      ),
      appriseUrls: normalizeAppriseUrls(
        notifications.appriseUrls,
        next.notifications.appriseUrls
      ),
      notifyOnStatusChange: normalizeBoolean(
        notifications.notifyOnStatusChange,
        next.notifications.notifyOnStatusChange
      ),
      notifyOnDelivered: normalizeBoolean(
        notifications.notifyOnDelivered,
        next.notifications.notifyOnDelivered
      ),
    };
  }

  if (typeof payload.carriers !== "undefined") {
    if (
      !payload.carriers ||
      typeof payload.carriers !== "object" ||
      Array.isArray(payload.carriers)
    ) {
      throw new Error("carriers must be an object");
    }

    const carriers = payload.carriers as Record<string, unknown>;
    for (const [carrier, value] of Object.entries(carriers)) {
      if (!CARRIER_SCHEMA_BY_NAME.has(carrier)) {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }

      const schema = CARRIER_SCHEMA_BY_NAME.get(carrier)!;
      const carrierInput = value as Record<string, unknown>;
      const nextCarrier = { ...(next.carriers[carrier] ?? {}) };

      for (const field of schema.fields) {
        if (!(field.key in carrierInput)) {
          continue;
        }

        const normalized = normalizeNonEmptyString(carrierInput[field.key]);
        if (normalized) {
          nextCarrier[field.key] = normalized;
        } else {
          delete nextCarrier[field.key];
        }
      }

      if (Object.keys(nextCarrier).length > 0) {
        next.carriers[carrier] = nextCarrier;
      } else {
        delete next.carriers[carrier];
      }
    }
  }

  next.version = 1;
  return next;
}

export function resolveEnvWithSettings(
  baseEnv: RuntimeEnv,
  settings: PaqqSettings
): RuntimeEnv {
  const resolved: RuntimeEnv = { ...baseEnv };

  for (const schema of CARRIER_CREDENTIAL_SCHEMAS) {
    const carrierValues = settings.carriers[schema.carrier];
    if (!carrierValues) {
      continue;
    }

    for (const field of schema.fields) {
      const value = normalizeNonEmptyString(carrierValues[field.key]);
      if (value) {
        resolved[field.envKey] = value;
      }
    }
  }

  return resolved;
}
