import { handleRequest } from './app';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    return handleRequest(request, env);
  }
};
