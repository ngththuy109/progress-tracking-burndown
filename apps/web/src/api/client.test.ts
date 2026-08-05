import { describe, expect, it, vi } from 'vitest';
import { configPayloadSchema } from '@app/shared';
import {
  ApiError,
  buildUrl,
  createApiClient,
  fallbackMessage,
  noContent,
  type ResponseParser,
} from './client.js';

/** Phản hồi JSON thật, không phải object giả — để đúng hành vi của `res.json()`. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

const VALID_CONFIG = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[{name}]', sortOrder: 1 }],
  subtaskPatterns: [],
  phaseDefinitions: [{ phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 1 }],
  matchRules: [],
  signboardColumns: [],
};

/** Nhận mọi thứ — dùng khi test không quan tâm tới nội dung trả về. */
const anything: ResponseParser<unknown> = { parse: (input) => input };

describe('buildUrl', () => {
  it('bỏ qua tham số undefined và null thay vì gửi chuỗi "undefined"', () => {
    const url = buildUrl('/api', '/epics', { project: undefined, epic: null, limit: 10 });
    expect(url).toBe('/api/epics?limit=10');
  });

  it('không thêm dấu ? khi không có tham số nào', () => {
    expect(buildUrl('/api', '/config/phase')).toBe('/api/config/phase');
  });

  it('mã hoá ký tự đặc biệt trong tham số', () => {
    expect(buildUrl('/api', '/epics', { q: 'a b&c' })).toBe('/api/epics?q=a+b%26c');
  });
});

describe('client — lỗi HTTP', () => {
  it('ném ApiError có mã lỗi khi API trả HTTP 400', async () => {
    const client = createApiClient({
      baseUrl: '/api',
      fetchImpl: async () =>
        jsonResponse(400, { error: 'CONFIG_INVALID', message: 'Cấu hình chưa hợp lệ.' }),
    });

    const err = await client.get('/config/phase', anything).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('CONFIG_INVALID');
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe('Cấu hình chưa hợp lệ.');
  });

  it('giữ lại danh sách issues để màn hình neo lỗi vào đúng ô', async () => {
    const client = createApiClient({
      baseUrl: '/api',
      fetchImpl: async () =>
        jsonResponse(400, {
          error: 'CONFIG_INVALID',
          message: 'Cấu hình chưa hợp lệ.',
          issues: [
            { level: 'ERROR', code: 'ORPHAN_PHASE_CODE', message: 'Phase không tồn tại.', path: 'matchRules.0' },
          ],
        }),
    });

    const err = (await client.get('/config/phase', anything).catch((e: unknown) => e)) as ApiError;

    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]?.path).toBe('matchRules.0');
  });

  it('dùng câu mặc định khi lỗi không phải JSON của mình', async () => {
    // Trang lỗi HTML của proxy: không có `message` nào để đọc.
    const client = createApiClient({
      baseUrl: '/api',
      fetchImpl: async () => textResponse(502, '<html><body>Bad Gateway</body></html>'),
    });

    const err = (await client.get('/config/phase', anything).catch((e: unknown) => e)) as ApiError;

    expect(err.code).toBe('SERVER_ERROR');
    expect(err.message).toContain('The server failed');
    expect(err.message).not.toContain('Bad Gateway');
  });

  it('KHÔNG tự thử lại — gọi fetch đúng một lần dù máy chủ trả 500', async () => {
    // Thử lại là việc của TanStack Query. Làm cả hai nơi thì một lần bấm thành
    // bốn request mà không ai chủ ý.
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'INTERNAL_ERROR', message: 'Lỗi hệ thống.' }));
    const client = createApiClient({ baseUrl: '/api', fetchImpl });

    await client.get('/config/phase', anything).catch(() => undefined);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('client — lỗi mạng', () => {
  it('thông báo hiển thị là câu do mình viết, không phải chuỗi thô của trình duyệt', async () => {
    const client = createApiClient({
      baseUrl: '/api',
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const err = (await client.get('/config/phase', anything).catch((e: unknown) => e)) as ApiError;

    expect(err.code).toBe('NETWORK');
    expect(err.message).toContain('Cannot reach the server');
    expect(err.message).not.toContain('Failed to fetch');
    // Nguyên văn của trình duyệt vẫn được giữ, nhưng ở `cause` — chỗ dành cho dev.
    expect((err.cause as Error).message).toBe('Failed to fetch');
  });

  it('query bị huỷ thì ném nguyên lỗi gốc, không bọc thành ApiError', async () => {
    // Người dùng gõ vào ô tìm kiếm là query cũ bị huỷ. Bọc thành ApiError sẽ
    // làm màn hình chớp thông báo đỏ sau mỗi phím bấm.
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    const client = createApiClient({
      baseUrl: '/api',
      fetchImpl: async () => {
        throw abort;
      },
    });

    const err = await client.get('/config/phase', anything).catch((e: unknown) => e);

    expect(err).toBe(abort);
    expect(err).not.toBeInstanceOf(ApiError);
  });
});

describe('client — kiểm dữ liệu tại biên', () => {
  it('ném lỗi khi phản hồi không khớp zod schema', async () => {
    // Thiếu `phaseDefinitions`. Không kiểm ở đây thì lỗi lộ ra dưới dạng
    // `undefined.length` ở giữa màn hình, cách chỗ gây lỗi rất xa.
    const client = createApiClient({
      baseUrl: '/api',
      fetchImpl: async () => jsonResponse(200, { fallbackScanFullTitle: true, titlePatterns: [] }),
    });

    const err = (await client
      .get('/config/phase', configPayloadSchema)
      .catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('RESPONSE_SHAPE_INVALID');
    expect(err.message).toContain('unexpected format');
  });

  it('ném lỗi khi máy chủ trả HTTP 200 nhưng thân không phải JSON', async () => {
    const client = createApiClient({
      baseUrl: '/api',
      fetchImpl: async () => textResponse(200, '<html>đăng nhập lại</html>'),
    });

    const err = (await client.get('/config/phase', anything).catch((e: unknown) => e)) as ApiError;

    expect(err.code).toBe('RESPONSE_NOT_JSON');
  });

  it('trả về dữ liệu ĐÃ qua zod, phần thừa bị cắt bỏ', async () => {
    const client = createApiClient({
      baseUrl: '/api',
      // API trả `EffectiveConfig`, tức có thêm metadata kế thừa.
      fetchImpl: async () =>
        jsonResponse(200, { ...VALID_CONFIG, projectKey: null, globalVersion: 3, projectVersion: null }),
    });

    const config = await client.get('/config/phase', configPayloadSchema);

    expect(config.phaseDefinitions[0]?.phaseCode).toBe('DESIGN');
    expect(config).not.toHaveProperty('globalVersion');
  });

  it('HTTP 204 không có thân thì parser nhận null, không nổ', async () => {
    const client = createApiClient({
      baseUrl: '/api',
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    await expect(client.delete('/epics/PAY-1', noContent)).resolves.toBeNull();
  });
});

describe('client — gửi request', () => {
  it('POST đặt Content-Type và chuyển thân sang JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const client = createApiClient({ baseUrl: '/api', fetchImpl });

    await client.post('/epics', { epicKeys: ['PAY-1'] }, anything);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/epics');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"epicKeys":["PAY-1"]}');
  });

  it('GET không kèm Content-Type và không kèm thân', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = createApiClient({ baseUrl: '/api', fetchImpl });

    await client.get('/epics', anything);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({});
  });
});

describe('câu thông báo mặc định', () => {
  const STATUSES = [400, 401, 403, 404, 409, 429, 500, 502, 418];

  it('mọi câu đều là câu hoàn chỉnh, không phải mã lỗi trần', () => {
    // Chữ trên màn hình là tiếng Anh, nên không kiểm được bằng dấu tiếng Việt
    // nữa. Thứ cần chặn vẫn y nguyên: một dòng cụt như "Bad Gateway" hay
    // "HTTP 502" lọt ra màn hình.
    for (const status of STATUSES) {
      const { message } = fallbackMessage(status);
      expect(message.trim().split(/\s+/).length, `HTTP ${status} — câu quá ngắn`).toBeGreaterThan(6);
      expect(message.trimEnd().endsWith('.'), `HTTP ${status} — câu không kết thúc bằng dấu chấm`).toBe(true);
    }
  });

  it('mọi câu đều nói người dùng phải làm gì tiếp (C-9)', () => {
    // Test này tồn tại để người thêm mã HTTP mới không viết mỗi "Something went wrong".
    const ACTIONS = ['Try again', 'try again', 'Reload', 'reload', 'Fix', 'Ask an admin', 'Wait', 'dev team'];
    for (const status of STATUSES) {
      const { message } = fallbackMessage(status);
      expect(
        ACTIONS.some((a) => message.includes(a)),
        `HTTP ${status} — câu "${message}" không nói cách khắc phục`,
      ).toBe(true);
    }
  });
});
