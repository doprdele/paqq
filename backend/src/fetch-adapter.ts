import { handleRequest, type RequestServices } from "./app";

export interface FetchRuntimeAdapter {
  fetch: (request: Request) => Promise<Response>;
}

export function createFetchRuntimeAdapter(
  env: Record<string, string | undefined>,
  services: RequestServices = {}
): FetchRuntimeAdapter {
  return {
    fetch: async (request: Request) => handleRequest(request, env, services),
  };
}
