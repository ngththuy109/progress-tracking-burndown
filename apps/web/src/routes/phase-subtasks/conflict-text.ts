import type { PlanConflict } from '@app/shared';

/**
 * Câu mô tả một vi phạm plan-ngày nghỉ, đủ để PM biết sửa gì trên Jira.
 * Ví dụ: "End 2026-08-11 is a JP holiday (山の日)".
 *
 * Dùng chung cho màn Phase sub-tasks và ô của bảng Signboard (T-37) — hai chỗ
 * phải nói cùng một câu, khác câu là người dùng tưởng hai lỗi khác nhau.
 */
export function conflictText(c: PlanConflict): string {
  return c.violations
    .map((v) => {
      const what = v.field === 'START' ? 'Start' : 'End';
      const why =
        v.reason === 'WEEKEND'
          ? `falls on a ${c.side} weekend`
          : `is a ${c.side} holiday${v.holidayLabel === null ? '' : ` (${v.holidayLabel})`}`;
      return `${what} ${v.date} ${why}`;
    })
    .join('; ');
}
