import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Principal } from '@app/shared';
import { registerMeRoutes } from './me.routes.js';

function build(principal: Principal | null): FastifyInstance {
  const app = Fastify({ logger: false });
  registerMeRoutes(app, { resolvePrincipal: () => principal });
  return app;
}

describe('GET /api/me', () => {
  it('trả về principal khi đã đăng nhập', async () => {
    const app = build({ userId: 'pm@x.com', role: 'PM', projects: ['PAY'] });
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: 'pm@x.com', role: 'PM', projects: ['PAY'] });
  });

  it('401 UNAUTHENTICATED khi không có người dùng đăng nhập', async () => {
    const app = build(null);
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHENTICATED');
  });
});
