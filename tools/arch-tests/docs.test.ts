import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALERT_CODE } from '@app/shared';

/**
 * Kiểm tài liệu bằng MÁY.
 *
 * Tài liệu không được kiểm sẽ mục trong ba tháng: đổi tên một lệnh trong
 * `package.json` mà quên sửa runbook thì không có gì báo, và người trực lúc 2
 * giờ sáng sẽ dán vào một lệnh không tồn tại.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}/${path}`, 'utf8');

describe('RUNBOOK.md', () => {
  const runbook = read('docs/RUNBOOK.md');

  it('có đủ 11 mục, khớp một-một với danh sách mã cảnh báo', () => {
    // Bảng 11 ngưỡng của PRD §10.4 rất dễ trở thành "10 ngưỡng cộng một dòng
    // tài liệu" — và cái bị bỏ sót sẽ đúng là cái không ai nhớ.
    for (const code of ALERT_CODE) {
      expect(runbook, `runbook thiếu mục cho ${code}`).toContain(`\`${code}\``);
    }
    expect(ALERT_CODE).toHaveLength(11);
  });

  it('mỗi mã cảnh báo có một tiêu đề mục riêng, không chỉ nằm trong bảng tra', () => {
    for (const code of ALERT_CODE) {
      expect(runbook, `${code} chưa có tiêu đề mục`).toMatch(new RegExp(`^## \\[P[123]\\] \`${code}\``, 'm'));
    }
  });

  it('có mục "khi nào KHÔNG nên tự sửa"', () => {
    // Người trực lúc nửa đêm có xu hướng thử mọi thứ; một dòng "đừng chạy lại
    // backfill khi job đêm đang chạy" tiết kiệm cả một ngày dọn dữ liệu.
    expect(runbook).toContain('khi nào KHÔNG nên tự sửa');
    expect(runbook).toContain('Đừng chạy lại backfill');
    expect(runbook).toContain('Đừng sửa thẳng bảng');
  });

  it('có bốn quy trình vận hành thường dùng', () => {
    for (const heading of [
      'Dựng lại lịch sử một Epic',
      'Đổi token Jira',
      'Tắt khẩn cấp việc gọi Jira',
      'Quay lại một version cấu hình',
    ]) {
      expect(runbook, `thiếu quy trình "${heading}"`).toContain(heading);
    }
  });

  it('mọi lệnh pnpm trong runbook đều có thật trong package.json', () => {
    // Đây là hàng rào chính chống tài liệu mục: đổi tên script mà quên sửa
    // runbook là đỏ ngay.
    const scripts = Object.keys(
      (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
    );

    const used = [...runbook.matchAll(/pnpm ([a-z0-9:]+)/g)].map((m) => m[1] ?? '');
    for (const name of new Set(used)) {
      expect(scripts, `runbook dùng "pnpm ${name}" nhưng package.json không có`).toContain(name);
    }
  });
});

describe('tài liệu và giao diện chỉ tới nhau', () => {
  const runbook = read('docs/RUNBOOK.md');
  const epicsScreen = read('apps/web/src/routes/epics/index.tsx');
  const burndownScreen = read('apps/web/src/routes/burndown/index.tsx');

  /**
   * Nhãn xuất hiện như CHỮ TRÊN NÚT, không phải trong ghi chú.
   *
   * Hai dạng đều tính: chữ viết thẳng trong JSX (`>Resync<`) và chuỗi nằm trong
   * biểu thức (`{paused ? 'Resume' : 'Pause (keep data)'}`). Chỉ nhận dạng đầu
   * thì mọi nhãn đổi theo trạng thái đều bị coi là không tồn tại.
   */
  const hasButtonLabel = (source: string, label: string): boolean =>
    new RegExp(`>\\s*${label}\\s*<`).test(source) || new RegExp(`'${label}'`).test(source);

  it('mọi nút mà runbook bảo "bấm ... ở màn hình Epic" đều có thật', () => {
    // Hướng dẫn chỉ tới một nút không tồn tại là lỗi im lặng thuần tuý: tài liệu
    // đọc vẫn xuôi, giao diện chạy vẫn tốt, chỉ người dùng là đi tìm mãi không ra.
    const referenced = [...runbook.matchAll(/Bấm \*\*(.+?)\*\* ở màn hình Epic/g)].map(
      (m) => m[1] ?? '',
    );

    expect(referenced.length, 'runbook không còn câu nào chỉ sang màn hình Epic').toBeGreaterThan(0);
    for (const label of referenced) {
      expect(
        hasButtonLabel(epicsScreen, label),
        `runbook chỉ tới nút "${label}" nhưng màn hình Epic không có nút nào tên vậy`,
      ).toBe(true);
    }
  });

  it('màn hình Biểu đồ cũng chỉ tới đúng nút đó', () => {
    expect(burndownScreen).toContain('click Resync on the Epics screen');
    expect(hasButtonLabel(epicsScreen, 'Resync')).toBe(true);
  });

  it('runbook mô tả đủ ba mức đồng bộ, và giao diện cho chọn đủ ba', () => {
    for (const level of ['{"full":true}', '{"full":false}', '{"from":"2026-03-01"']) {
      expect(runbook, `runbook thiếu mức ${level}`).toContain(level);
    }

    const modes = read('apps/web/src/routes/epics/resync-modes.ts');
    for (const mode of ['QUICK', 'FULL', 'RANGE']) {
      expect(modes, `giao diện thiếu mức ${mode}`).toContain(`'${mode}'`);
    }
  });

  it('tài liệu tiếng Việt trích ĐÚNG nhãn tiếng Anh đang hiện trên màn hình', () => {
    // Chữ trên giao diện là tiếng Anh, còn tài liệu vận hành vẫn tiếng Việt.
    // Chỗ nối giữa hai thứ là nhãn nút — trích sai là người trực đi tìm không ra.
    const uat = read('docs/UAT-CHECKLIST.md');
    const epicsScreenLabels = ['Resync', 'Pause \\(keep data\\)', 'Untrack \\(delete data\\)'];

    for (const label of epicsScreenLabels) {
      expect(
        hasButtonLabel(epicsScreen, label),
        `tài liệu nhắc nhãn "${label}" nhưng màn hình Epic không có`,
      ).toBe(true);
    }
    for (const doc of [runbook, uat]) {
      expect(doc).toMatch(/\*\*Resync\*\*/);
    }
  });
});

describe('UAT-CHECKLIST.md', () => {
  const uat = read('docs/UAT-CHECKLIST.md');

  it('phủ đủ 15 user story', () => {
    for (let i = 1; i <= 15; i++) {
      const code = `US-${String(i).padStart(2, '0')}`;
      expect(uat, `checklist thiếu ${code}`).toContain(code);
    }
  });

  it('mỗi dòng có cả thao tác lẫn tiêu chí đạt', () => {
    // Checklist mà cần dev ngồi cạnh giải thích thì chưa xong.
    expect(uat).toContain('Đạt khi thấy');
    expect(uat).toContain('Chỗ phải hỏi dev');
  });
});

describe('ONBOARDING.md', () => {
  const onboarding = read('docs/ONBOARDING.md');

  it('nói rõ hai hàng rào kiến trúc và LÝ DO của chúng', () => {
    expect(onboarding).toContain('KHÔNG được import');
    expect(onboarding).toContain('KHÔNG được đọc đồng hồ');
    expect(onboarding).toContain('xanh hôm nay và đỏ tuần sau');
  });

  it('nói đúng cổng dev là 5180, không phải cổng mặc định của Vite', () => {
    expect(onboarding).toContain('5180');
    expect(onboarding).toContain('5199');
  });

  it('mọi lệnh pnpm đều có thật trong package.json', () => {
    const scripts = Object.keys(
      (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
    );
    const used = [...onboarding.matchAll(/pnpm ([a-z0-9:]+)/g)].map((m) => m[1] ?? '');
    for (const name of new Set(used)) {
      if (name === 'install') continue; // lệnh dựng sẵn của pnpm
      expect(scripts, `onboarding dùng "pnpm ${name}" nhưng package.json không có`).toContain(name);
    }
  });
});
