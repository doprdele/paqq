import { describe, expect, it } from "vitest";
import {
  applySettingsPatch,
  defaultPaqqSettings,
  parsePersistedSettings,
  resolveEnvWithSettings,
} from "../src/settings-schema";

describe("settings schema", () => {
  it("applies notification and carrier patches", () => {
    const updated = applySettingsPatch(defaultPaqqSettings(), {
      notifications: {
        enabled: true,
        appriseUrls: ["discord://token@123/456", "slack://x/y/z"],
        notifyOnStatusChange: false,
      },
      carriers: {
        fedex: {
          clientId: "fedex-client",
          clientSecret: "fedex-secret",
        },
      },
    });

    expect(updated.notifications.enabled).toBe(true);
    expect(updated.notifications.appriseUrls).toHaveLength(2);
    expect(updated.notifications.notifyOnStatusChange).toBe(false);
    expect(updated.carriers.fedex.clientId).toBe("fedex-client");
    expect(updated.carriers.fedex.clientSecret).toBe("fedex-secret");
  });

  it("ignores unknown carriers while keeping known values", () => {
    const updated = applySettingsPatch(defaultPaqqSettings(), {
      carriers: {
        unknownCarrier: { key: "value" },
        dhl: { apiKey: "dhl-key" },
      },
    });

    expect(updated.carriers.unknownCarrier).toBeUndefined();
    expect(updated.carriers.dhl.apiKey).toBe("dhl-key");
  });

  it("resolves env vars from carrier credential settings", () => {
    const settings = applySettingsPatch(defaultPaqqSettings(), {
      carriers: {
        asendia: { authorizationBasic: "asendia-auth" },
        mondialrelay: { requestVerificationToken: "mr-token" },
        laposte: { okapiKey: "laposte-key" },
        dhl: { apiKey: "dhl-key" },
        fedex: { clientId: "fedex-id", clientSecret: "fedex-secret" },
        ups: { scraperToken: "ups-token" },
      },
    });

    const env = resolveEnvWithSettings({}, settings);
    expect(env.A1_API_KEY).toBe("asendia-auth");
    expect(env.MR_API_KEY).toBe("mr-token");
    expect(env.LAPOSTE_API_KEY).toBe("laposte-key");
    expect(env.DHL_API_KEY).toBe("dhl-key");
    expect(env.FEDEX_API_KEY).toBe("fedex-id");
    expect(env.FEDEX_SECRET_KEY).toBe("fedex-secret");
    expect(env.UPS_SCRAPER_TOKEN).toBe("ups-token");
  });

  it("parses persisted settings and falls back to defaults", () => {
    const parsed = parsePersistedSettings({
      notifications: { enabled: true, appriseUrls: ["discord://token@1/2"] },
      carriers: { ups: { scraperToken: "token" } },
    });
    expect(parsed.notifications.enabled).toBe(true);
    expect(parsed.notifications.appriseUrls).toEqual(["discord://token@1/2"]);
    expect(parsed.carriers.ups.scraperToken).toBe("token");

    const fallback = parsePersistedSettings(null);
    expect(fallback.notifications.enabled).toBe(false);
    expect(fallback.carriers).toEqual({});
  });
});
