import type { ConfigPayload } from '@app/shared';
import type { PrismaClient } from '../client.js';
import { findActiveConfigSet, saveNewVersion } from '../repositories/phase-config.repository.js';

/**
 * Bộ cấu hình Mặc định — PRD §2.2.2 (6 Phase) và §2.9.3 (5 cột Signboard).
 *
 * Đây chỉ là ĐIỂM XUẤT PHÁT. PM sửa được toàn bộ qua màn hình quản trị mà không
 * cần dev và không cần deploy — đó là mục đích của cả nhóm card cấu hình.
 */
export const DEFAULT_PHASE_CONFIG: ConfigPayload = {
  // Lưới an toàn cho project không dùng tiền tố nào: nếu không mẫu nào khớp thì
  // tìm từ khoá trên toàn bộ tiêu đề. Nhờ vậy tiêu đề trần "詳細設計" vẫn nhận ra
  // được DESIGN.
  fallbackScanFullTitle: true,

  titlePatterns: [
    { patternText: '[Phase] {name}', sortOrder: 1 },
    { patternText: '【{name}】', sortOrder: 2 },
  ],

  subtaskPatterns: [
    { patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 },
  ],

  phaseDefinitions: [
    { phaseCode: 'REQUIREMENT', labelVi: 'Yêu cầu', labelJa: '要件定義', colorHex: '#6B7280', displayOrder: 1 },
    { phaseCode: 'DESIGN', labelVi: 'Thiết kế', labelJa: '設計', colorHex: '#4A90D9', displayOrder: 2 },
    { phaseCode: 'DEVELOPMENT', labelVi: 'Phát triển', labelJa: '開発', colorHex: '#2E9E5B', displayOrder: 3 },
    { phaseCode: 'TESTING', labelVi: 'Kiểm thử', labelJa: 'テスト', colorHex: '#E8A33D', displayOrder: 4 },
    { phaseCode: 'UAT', labelVi: 'Nghiệm thu', labelJa: '受入テスト', colorHex: '#B45FD4', displayOrder: 5 },
    { phaseCode: 'RELEASE', labelVi: 'Triển khai', labelJa: 'リリース', colorHex: '#D9534F', displayOrder: 6 },
  ],

  /**
   * `matchPriority` mặc định 50. Các từ khoá dài và cụ thể hơn để 10 để thắng
   * trước — ví dụ "Design Review" phải thắng "Design".
   *
   * Nhắc lại: khi `matchPriority` bằng nhau thì TỪ KHOÁ DÀI HƠN thắng, nên phần
   * lớn trường hợp không cần chỉnh số này (PRD §2.2.3).
   */
  matchRules: [
    { keyword: 'Requirement', matchMode: 'CONTAINS', phaseCode: 'REQUIREMENT', matchPriority: 50 },
    { keyword: '要件定義', matchMode: 'CONTAINS', phaseCode: 'REQUIREMENT', matchPriority: 50 },
    { keyword: 'Yêu cầu', matchMode: 'CONTAINS', phaseCode: 'REQUIREMENT', matchPriority: 50 },

    { keyword: 'Design Review', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 10 },
    { keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
    { keyword: '基本設計', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
    { keyword: '詳細設計', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
    { keyword: '設計', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 60 },
    { keyword: 'Thiết kế', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },

    { keyword: 'Development', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 50 },
    { keyword: 'Implementation', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 50 },
    { keyword: 'Dev', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 70 },
    { keyword: '開発', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 50 },
    { keyword: '実装', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 50 },
    { keyword: 'Phát triển', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 50 },

    { keyword: '受入テスト', matchMode: 'CONTAINS', phaseCode: 'UAT', matchPriority: 20 },
    { keyword: 'UAT', matchMode: 'CONTAINS', phaseCode: 'UAT', matchPriority: 20 },
    { keyword: 'Nghiệm thu', matchMode: 'CONTAINS', phaseCode: 'UAT', matchPriority: 20 },

    { keyword: 'Testing', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 50 },
    { keyword: 'Test', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 70 },
    { keyword: 'QA', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 50 },
    { keyword: 'テスト', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 60 },
    { keyword: '試験', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 50 },
    { keyword: 'Kiểm thử', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 50 },

    { keyword: 'Release', matchMode: 'CONTAINS', phaseCode: 'RELEASE', matchPriority: 50 },
    { keyword: 'Deployment', matchMode: 'CONTAINS', phaseCode: 'RELEASE', matchPriority: 50 },
    { keyword: 'リリース', matchMode: 'CONTAINS', phaseCode: 'RELEASE', matchPriority: 50 },
    { keyword: '本番', matchMode: 'CONTAINS', phaseCode: 'RELEASE', matchPriority: 50 },
    { keyword: 'Triển khai', matchMode: 'CONTAINS', phaseCode: 'RELEASE', matchPriority: 50 },
  ],

  /**
   * Thứ tự Sub-phase trong từng Phase trên Signboard — Mặc định RỖNG.
   *
   * Sub-phase là thứ của từng dự án (ví dụ `FUT_ConfirmPoint` trước
   * `FUT_TestCase`), không có bộ "chuẩn" nào để seed. Chưa khai thì bảng tự xếp:
   * khớp Phase → theo `display_order`, lạ → A→Z, "(No sub-phase)" cuối.
   */
  subPhaseOrders: [],

  signboardColumns: [
    { taskCode: 'Create', labelVi: 'Tạo mới', labelJa: '作成', displayOrder: 1 },
    { taskCode: 'BALReview', labelVi: 'BAL review', labelJa: 'BALレビュー', displayOrder: 2 },
    { taskCode: 'FixCommentBAL', labelVi: 'Sửa comment BAL', labelJa: 'BAL指摘対応', displayOrder: 3 },
    { taskCode: 'JMReview', labelVi: 'JM review', labelJa: 'JMレビュー', displayOrder: 4 },
    { taskCode: 'FixCommentJM', labelVi: 'Sửa comment JM', labelJa: 'JM指摘対応', displayOrder: 5 },
  ],
};

/** Giá trị ghi vào cột `created_by` khi seed — KHÔNG phải người dùng thật. */
export const SEED_AUTHOR = 'system';

export interface SeedDefaultConfigResult {
  /** `true` nếu vừa tạo bộ Mặc định; `false` nếu đã có sẵn (chạy lại vô hại). */
  readonly seeded: boolean;
  /** Version của bộ Mặc định (GLOBAL) đang hiệu lực sau khi seed. */
  readonly version: number;
}

/**
 * Seed bộ cấu hình Mặc định (GLOBAL) nếu CHƯA có bộ nào đang hiệu lực.
 *
 * Vì sao có bước này: migration chỉ TẠO BẢNG, không nạp dữ liệu. Seed cho một
 * ĐIỂM XUẤT PHÁT hợp lý (6 Phase + luật khớp Việt/Nhật/Anh + 5 cột Signboard)
 * thay vì màn hình trống. **KHÔNG bắt buộc:** `GET /api/config/phase` trả về bộ
 * RỖNG khi chưa có Mặc định, nên màn hình Phase settings / Signboard columns vẫn
 * mở bình thường để admin tự định nghĩa rồi Lưu (tạo GLOBAL v1). Seed chỉ là
 * tiện lợi để không phải gõ tay từ đầu.
 *
 * Đi qua đúng `saveNewVersion` mà API dùng, nên dữ liệu seed có CÙNG hình dạng
 * API mong đợi — `DEFAULT_PHASE_CONFIG` là nguồn sự thật duy nhất, không nhân
 * bản logic ghi thành SQL tay dễ lệch.
 *
 * Idempotent (C-6): đã có bộ GLOBAL đang hiệu lực thì KHÔNG tạo version mới —
 * chạy lại mỗi lần deploy đều vô hại, giống `seedWorkCalendars` và `seed:admin`.
 */
export async function seedDefaultPhaseConfig(
  prisma: PrismaClient,
): Promise<SeedDefaultConfigResult> {
  const existing = await findActiveConfigSet(prisma, 'GLOBAL', null);
  if (existing) return { seeded: false, version: existing.version };

  const { version } = await saveNewVersion(prisma, {
    scope: 'GLOBAL',
    projectKey: null,
    payload: DEFAULT_PHASE_CONFIG,
    createdBy: SEED_AUTHOR,
    note: 'Bộ Mặc định khởi tạo (seed).',
  });
  return { seeded: true, version };
}
