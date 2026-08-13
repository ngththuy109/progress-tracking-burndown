import { describe, it, expect } from 'vitest';
import { changelogItemSchema, changelogPageSchema, getUsersByAccountIds } from './endpoints.js';
import { BasicAuthProvider } from './credentials.js';
import { JiraClient } from './client.js';

const CREDS = {
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'svc@example.com',
  JIRA_API_TOKEN: 'secret-token-123',
};

function makeClient(fetchImpl: typeof fetch) {
  return new JiraClient({
    credentials: new BasicAuthProvider(CREDS as unknown as NodeJS.ProcessEnv),
    fetchImpl,
    retry: { sleep: async () => {}, random: () => 0.5 },
  });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Bẫy `toString`.
 *
 * Jira đặt tên trường đúng bằng `toString`, trùng với hàm có sẵn trên
 * `Object.prototype`. Không xử lý thì mọi changelog item KHÔNG có trường đó sẽ
 * làm hỏng việc parse cả trang — và trong dữ liệu Jira thật thì phần lớn item
 * đều không có nó.
 *
 * Lỗi này chỉ lộ ra khi chạy với dữ liệu thiếu trường; test dựng dữ liệu "đầy
 * đủ" sẽ luôn xanh và không bao giờ bắt được.
 */
describe('changelog — bẫy trường tên toString', () => {
  it('item KHÔNG có trường toString vẫn parse được', () => {
    const r = changelogItemSchema.safeParse({ field: 'status', from: '1', to: '3' });
    expect(r.success).toBe(true);
  });

  it('item CÓ trường toString thì giữ đúng giá trị chuỗi', () => {
    const r = changelogItemSchema.safeParse({
      field: 'status',
      to: '3',
      toString: 'In Progress',
      fromString: 'To Do',
    });
    expect(r.success).toBe(true);
    expect((r as { data: Record<string, unknown> }).data['toString']).toBe('In Progress');
    expect((r as { data: Record<string, unknown> }).data['fromString']).toBe('To Do');
  });

  it('cả trang changelog parse được khi item thiếu toString', () => {
    const page = changelogPageSchema.safeParse({
      values: [
        {
          id: '5001',
          created: '2026-03-05T02:00:00.000+0000',
          items: [{ field: 'status', from: '1', to: '3' }],
        },
      ],
      isLast: true,
    });
    expect(page.success).toBe(true);
  });

  it('item thiếu trường bắt buộc `field` vẫn bị từ chối', () => {
    // Bỏ prototype không được làm mất khả năng kiểm tra
    expect(changelogItemSchema.safeParse({ from: '1', to: '3' }).success).toBe(false);
  });

  it('trường toString mang kiểu sai vẫn bị từ chối', () => {
    expect(changelogItemSchema.safeParse({ field: 'status', toString: 42 }).success).toBe(false);
  });
});

describe('getUsersByAccountIds — tra tên PIC', () => {
  it('gửi mỗi accountId thành một tham số query LẶP LẠI và trả về user đã parse', async () => {
    const urls: string[] = [];
    const client = makeClient(async (input) => {
      urls.push(String(input));
      return jsonResponse({
        values: [
          { accountId: 'u1', displayName: 'Nguyễn An' },
          { accountId: 'u2', displayName: 'Trần Bình' },
        ],
        isLast: true,
      });
    });

    const users = await getUsersByAccountIds(client, ['u1', 'u2']);

    expect(users).toEqual([
      { accountId: 'u1', displayName: 'Nguyễn An' },
      { accountId: 'u2', displayName: 'Trần Bình' },
    ]);
    // Query mang HAI accountId (endpoint /user/bulk nhận nhiều), không ghi đè nhau.
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/rest/api/3/user/bulk');
    expect(url.searchParams.getAll('accountId')).toEqual(['u1', 'u2']);
  });

  it('phân trang: đi tiếp khi chưa hết trang', async () => {
    let call = 0;
    const client = makeClient(async () => {
      call += 1;
      return call === 1
        ? jsonResponse({ values: [{ accountId: 'u1', displayName: 'An' }], isLast: false, total: 2 })
        : jsonResponse({ values: [{ accountId: 'u2', displayName: 'Bình' }], isLast: true, total: 2 });
    });

    const users = await getUsersByAccountIds(client, ['u1', 'u2']);
    expect(users.map((u) => u.accountId)).toEqual(['u1', 'u2']);
    expect(call).toBe(2);
  });

  it('user bị ẩn/xoá (thiếu displayName) vẫn parse được', async () => {
    const client = makeClient(async () => jsonResponse({ values: [{ accountId: 'u1' }], isLast: true }));
    const users = await getUsersByAccountIds(client, ['u1']);
    expect(users).toEqual([{ accountId: 'u1' }]);
  });
});
