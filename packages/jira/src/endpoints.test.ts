import { describe, it, expect } from 'vitest';
import { changelogItemSchema, changelogPageSchema } from './endpoints.js';

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
