import { handleList } from './handlers/list';
import { handleGet } from './handlers/get';
import { sourcesRegistry } from './sources';
import type { TrackingScheduler } from './scheduler';

interface RequestServices {
  scheduler?: TrackingScheduler;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function handleRequest(
  request: Request,
  env: any,
  services: RequestServices = {}
): Promise<Response> {
  sourcesRegistry.initialize(env);

  const url = new URL(request.url);

  if (url.pathname === '/api/list') {
    return handleList(request);
  }

  if (url.pathname === '/api/get') {
    return handleGet(request, env, services.scheduler);
  }

  if (url.pathname === '/api/scheduler/status') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }
    return jsonResponse(services.scheduler.getStatus());
  }

  if (url.pathname === '/api/scheduler/targets') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }
    const targets = await services.scheduler.listTargets();
    return jsonResponse(targets);
  }

  if (url.pathname === '/api/scheduler/watch' && request.method === 'POST') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const source = typeof payload?.source === 'string' ? payload.source.trim() : '';
    const params = payload?.params;
    const friendlyName =
      typeof payload?.friendlyName === 'string' && payload.friendlyName.trim().length > 0
        ? payload.friendlyName.trim()
        : undefined;

    if (!source || !sourcesRegistry.has(source)) {
      return jsonResponse({ error: 'Source not found' }, 404);
    }

    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return jsonResponse({ error: 'params must be an object' }, 400);
    }

    const normalizedParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return jsonResponse({ error: `Invalid param value for '${key}'` }, 400);
      }
      normalizedParams[key] = value.trim();
    }

    const trackingSource = sourcesRegistry.get(source)!;
    for (const field of trackingSource.getConfig().requiredFields) {
      if (!normalizedParams[field]) {
        return jsonResponse({ error: `Missing required field: ${field}` }, 400);
      }
    }

    await services.scheduler.registerTarget(source, normalizedParams, { friendlyName });
    return jsonResponse({ ok: true });
  }

  if (url.pathname === '/api/scheduler/unwatch' && request.method === 'POST') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const source = typeof payload?.source === 'string' ? payload.source.trim() : '';
    const params = payload?.params;

    if (!source || !sourcesRegistry.has(source)) {
      return jsonResponse({ error: 'Source not found' }, 404);
    }

    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return jsonResponse({ error: 'params must be an object' }, 400);
    }

    const normalizedParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return jsonResponse({ error: `Invalid param value for '${key}'` }, 400);
      }
      normalizedParams[key] = value.trim();
    }

    const removed = await services.scheduler.unregisterTarget(source, normalizedParams);
    return jsonResponse({ removed });
  }

  if (url.pathname === '/api/scheduler/run' && request.method === 'POST') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }
    const started = await services.scheduler.runNow({ force: true });
    return jsonResponse({ started });
  }

  return new Response('Not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
}
