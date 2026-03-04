import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import {
  persistCarrierSessionState,
  withCarrierSessionState,
} from "../src/session-state.js";

const ORIGINAL_ENV = { ...process.env };
const createdDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paqq-session-state-"));
  createdDirs.push(dir);
  return dir;
}

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (typeof ORIGINAL_ENV[key] === "undefined") {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
}

afterEach(async () => {
  restoreEnv();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("session state persistence", () => {
  it("loads persisted storage state when enabled", async () => {
    const stateDir = await makeTempDir();
    process.env.PAQQ_SCRAPER_STATE_DIR = stateDir;
    process.env.PAQQ_SCRAPER_PERSIST_SESSION_STATE = "1";

    const persistedState = {
      cookies: [
        {
          name: "session",
          value: "abc123",
          domain: ".amazon.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: "https://www.amazon.com",
          localStorage: [{ name: "k", value: "v" }],
        },
      ],
    };
    await writeFile(
      join(stateDir, "amazon.storage-state.json"),
      JSON.stringify(persistedState),
      "utf8"
    );

    const options = await withCarrierSessionState("amazon", {
      locale: "en-US",
    });

    expect(options.storageState).toEqual(persistedState);
  });

  it("respects carrier-level disable override", async () => {
    const stateDir = await makeTempDir();
    process.env.PAQQ_SCRAPER_STATE_DIR = stateDir;
    process.env.PAQQ_SCRAPER_PERSIST_SESSION_STATE = "1";
    process.env.AMAZON_PERSIST_SESSION_STATE = "0";

    await writeFile(
      join(stateDir, "amazon.storage-state.json"),
      JSON.stringify({ cookies: [], origins: [] }),
      "utf8"
    );

    const options = await withCarrierSessionState("amazon", {
      locale: "en-US",
    });

    expect(options.storageState).toBeUndefined();
  });

  it("persists context storage state to disk", async () => {
    const stateDir = await makeTempDir();
    process.env.PAQQ_SCRAPER_STATE_DIR = stateDir;
    process.env.PAQQ_SCRAPER_PERSIST_SESSION_STATE = "1";

    const savedState = {
      cookies: [
        {
          name: "ups-token",
          value: "token",
          domain: ".ups.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    };

    const context = {
      storageState: vi.fn(async () => savedState),
    } as unknown as BrowserContext;

    await persistCarrierSessionState("ups", context);

    const savedRaw = await readFile(
      join(stateDir, "ups.storage-state.json"),
      "utf8"
    );
    expect(JSON.parse(savedRaw)).toEqual(savedState);
    expect(context.storageState).toHaveBeenCalledTimes(1);
  });
});
