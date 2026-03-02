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

  if (url.pathname === '/api/scheduler/run' && request.method === 'POST') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }
    const started = await services.scheduler.runNow({ force: true });
    return jsonResponse({ started });
  }

  return new Response('Not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
}
