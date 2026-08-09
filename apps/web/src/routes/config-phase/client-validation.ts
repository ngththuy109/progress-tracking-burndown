import { configPayloadSchema, fieldPath, type ConfigPayload } from '@app/shared';
import type { ApiErrorIssue } from '../../api/client.js';

/**
 * Kiểm hình dạng cấu hình NGAY TẠI CLIENT, trước khi gửi đi.
 *
 * Vì sao cần: nếu chỉ dựa vào máy chủ, PM bấm Lưu lúc dòng Phase còn trống sẽ
 * phải chờ một vòng request rồi nhận về HTTP 400 — trong khi lỗi (thiếu tên
 * Phase, thiếu từ khoá...) hoàn toàn biết trước ngay tại client. Kiểm ở đây cho
 * phản hồi TỨC THÌ, và chặn luôn request chắc chắn hỏng.
 *
 * CHỈ kiểm phần hình dạng bằng chính `configPayloadSchema` của `@app/shared` —
 * đủ để bắt mọi ô bắt buộc còn trống, và KHÔNG khai lại quy tắc ở client (khai
 * lại là hai bên lệch nhau). Luật nghiệp vụ (trùng mã Phase, luật trỏ tới Phase
 * chưa định nghĩa...) vẫn để máy chủ kiểm và trả về đã neo sẵn đường dẫn.
 *
 * Đường dẫn đi qua `fieldPath` để khớp đúng quy ước `field[index].subfield` mà
 * `field-errors.ts` dùng — cùng một hàm máy chủ dùng, nên không thể lệch nhau.
 */
export function validateDraftClient(payload: ConfigPayload): ApiErrorIssue[] {
  const parsed = configPayloadSchema.safeParse(payload);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    level: 'ERROR' as const,
    code: 'SCHEMA_INVALID',
    message: issue.message,
    path: fieldPath(issue.path),
  }));
}
