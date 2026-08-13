import {
  getUsersByAccountIds,
  readRequestParticipants,
  type JiraClient,
  type JiraIssue,
  type ResolvedFieldMapping,
} from '@app/jira';

/**
 * Tra tên hiển thị cho "Request participants" (cột PIC của Signboard).
 *
 * VÌ SAO Ở ĐÂY, không nằm trong `buildRecords`: `buildRecords` là hàm THUẦN
 * (không gọi mạng), còn tra tên phải gọi Jira. Nên bước này chạy trước, trả về
 * bản đồ `accountId → tên` để `buildRecords` tra cứu.
 *
 * Cần tra tối thiểu: field "Request participants" THƯỜNG trả kèm `displayName`
 * ngay trong phản hồi issue — khi đó KHÔNG tốn thêm lời gọi nào. Chỉ những
 * accountId field trả về TRỐNG tên mới hỏi `/user/bulk`.
 *
 * KHÔNG được làm hỏng cả lượt đồng bộ: thiếu quyền "Browse users" hay endpoint
 * lỗi thì nuốt lỗi, trả về map đang có (cột PIC hiện accountId thay vì tên) kèm
 * một cảnh báo để nơi gọi ghi log.
 */
export interface ResolvedParticipantNames {
  /** `accountId` → tên hiển thị (chỉ chứa những người tra được tên). */
  readonly names: ReadonlyMap<string, string>;
  readonly warnings: readonly { code: string; message: string }[];
}

export async function resolveParticipantNames(
  client: JiraClient,
  issues: readonly JiraIssue[],
  fields: ResolvedFieldMapping,
): Promise<ResolvedParticipantNames> {
  const names = new Map<string, string>();
  // Field chưa cấu hình → không có gì để tra.
  if (fields.requestParticipants === undefined) return { names, warnings: [] };

  // Gom tên có sẵn từ chính field, và tập accountId còn THIẾU tên.
  const missing = new Set<string>();
  for (const issue of issues) {
    for (const ref of readRequestParticipants(issue, fields)) {
      if (ref.displayName !== null) names.set(ref.accountId, ref.displayName);
      else missing.add(ref.accountId);
    }
  }
  // accountId nào đã có tên (từ field, ở issue khác) thì khỏi hỏi lại.
  for (const id of names.keys()) missing.delete(id);
  if (missing.size === 0) return { names, warnings: [] };

  try {
    const users = await getUsersByAccountIds(client, [...missing]);
    for (const u of users) {
      if (u.displayName !== undefined && u.displayName !== '') names.set(u.accountId, u.displayName);
    }
    return { names, warnings: [] };
  } catch (err) {
    return {
      names,
      warnings: [
        {
          code: 'PARTICIPANT_NAMES_UNRESOLVED',
          message:
            `Không tra được tên cho ${missing.size} accountId trong "Request participants" ` +
            `(${err instanceof Error ? err.message : String(err)}). Cột PIC sẽ hiện accountId ` +
            `thay vì tên. Kiểm tra tài khoản đồng bộ có quyền "Browse users and groups".`,
        },
      ],
    };
  }
}
