import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/app';

describe('runtime-neutral app handler', () => {
  it('serves /api/list through shared handler', async () => {
    const env = { USPS_SCRAPER_URL: 'http://127.0.0.1:8790' };
    const response = await handleRequest(new Request('https://packt.test/api/list'), env);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Array<{ name: string }>;
    expect(payload.some((source) => source.name === 'usps')).toBe(true);
  });

  it('returns 404 for unknown paths', async () => {
    const response = await handleRequest(new Request('https://packt.test/unknown'), {});
    expect(response.status).toBe(404);
  });

  it('returns 404 for scheduler endpoint in worker runtime', async () => {
    const response = await handleRequest(new Request('https://packt.test/api/scheduler/status'), {});
    expect(response.status).toBe(404);
  });
});
