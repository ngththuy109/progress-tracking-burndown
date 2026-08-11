import { describe, it, expect } from 'vitest';
import type { ConfigPayload } from '@app/shared';
import { validateDraftClient } from './client-validation.js';

const VALID: ConfigPayload = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[Phase] {name}', sortOrder: 1 }],
  subtaskPatterns: [{ patternText: '[{function}]_{task}', sortOrder: 1 }],
  phaseDefinitions: [{ phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 1 }],
  matchRules: [{ keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 }],
  signboardColumns: [{ taskCode: 'Create', labelVi: 'Tạo mới', side: 'VN', displayOrder: 1 }],
};

describe('validateDraftClient', () => {
  it('cấu hình hợp lệ không có lỗi nào', () => {
    expect(validateDraftClient(VALID)).toEqual([]);
  });

  it('Phase mới thêm còn trống: lỗi neo đúng dòng, thông báo đọc được', () => {
    const draft: ConfigPayload = {
      ...VALID,
      phaseDefinitions: [
        ...VALID.phaseDefinitions,
        { phaseCode: '', labelVi: '', displayOrder: 2 },
      ],
    };
    const issues = validateDraftClient(draft);

    const byPath = new Map(issues.map((i) => [i.path, i.message]));
    expect(byPath.get('phaseDefinitions[1].phaseCode')).toBe('Phase code is required.');
    expect(byPath.get('phaseDefinitions[1].labelVi')).toBe('Phase name is required.');
    // Không được rò khoá bọc `payload`/`draft` ra đường dẫn — đó là chỗ neo hỏng.
    expect(issues.every((i) => !(i.path ?? '').startsWith('payload'))).toBe(true);
    expect(issues.every((i) => i.level === 'ERROR')).toBe(true);
  });

  it('luật khớp còn trống từ khoá: lỗi neo vào matchRules[i].keyword', () => {
    const draft: ConfigPayload = {
      ...VALID,
      matchRules: [
        ...VALID.matchRules,
        { keyword: '', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
      ],
    };
    const paths = validateDraftClient(draft).map((i) => i.path);
    expect(paths).toContain('matchRules[1].keyword');
  });

  it('cột Signboard còn trống mã: lỗi neo vào signboardColumns[i].taskCode', () => {
    const draft: ConfigPayload = {
      ...VALID,
      signboardColumns: [
        ...VALID.signboardColumns,
        { taskCode: '', labelVi: '', side: 'VN', displayOrder: 2 },
      ],
    };
    const paths = validateDraftClient(draft).map((i) => i.path);
    expect(paths).toContain('signboardColumns[1].taskCode');
    expect(paths).toContain('signboardColumns[1].labelVi');
  });
});
