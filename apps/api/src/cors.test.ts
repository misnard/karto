import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { seedUser } from './test/helpers.ts';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function request(method: string, path: string, headers: Record<string, string>): Promise<Response> {
  return exports.default.fetch(`http://api.test${path}`, { method, headers });
}

describe('CORS', () => {
  it('answers the preflight of an extension origin, before auth', async () => {
    const res = await request('OPTIONS', '/v1/baskets', {
      origin: EXTENSION,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXTENSION);
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
    expect(res.headers.get('access-control-allow-methods')?.split(',')).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    );
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('lets the extension read successes and errors (a 401 must reach it to unpair)', async () => {
    const { token } = await seedUser();
    const ok = await request('GET', '/v1/me', { origin: EXTENSION, authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(EXTENSION);

    const denied = await request('GET', '/v1/me', { origin: EXTENSION });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('access-control-allow-origin')).toBe(EXTENSION);
  });

  it.each(['https://evil.example', 'http://localhost:5173', 'moz-extension://abc'])(
    'ignores the origin %s',
    async (origin) => {
      const res = await request('OPTIONS', '/v1/me', { origin, 'access-control-request-method': 'GET' });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    },
  );
});
