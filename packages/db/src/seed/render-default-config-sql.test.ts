import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderDefaultConfigSql, SEED_SQL_RELATIVE_PATH } from './render-default-config-sql.js';
import { DEFAULT_PHASE_CONFIG } from './default-phase-config.js';

/**
 * Giữ file SQL đã commit LUÔN khớp với `DEFAULT_PHASE_CONFIG`.
 *
 * File `tools/db/seed-default-config.sql` là bản chép dữ liệu thứ hai (bên cạnh
 * hằng số TS). Không có test này thì sửa hằng số mà quên sinh lại file là lỗi im
 * lặng: `pnpm db:seed` cho dữ liệu mới, còn ai chạy file SQL lại nhận dữ liệu cũ.
 */
describe('SQL seed sinh từ DEFAULT_PHASE_CONFIG', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const committed = readFileSync(`${repoRoot}${SEED_SQL_RELATIVE_PATH}`, 'utf8');

  it('file đã commit khớp TỪNG BYTE với hàm sinh', () => {
    // Đỏ ở đây nghĩa là quên `pnpm db:seed:sql:gen` sau khi đổi hằng số cấu hình.
    expect(committed).toBe(renderDefaultConfigSql());
  });

  it('có đủ mọi Phase, luật khớp và cột từ hằng số', () => {
    const sql = renderDefaultConfigSql();
    for (const p of DEFAULT_PHASE_CONFIG.phaseDefinitions) {
      expect(sql, `thiếu Phase ${p.phaseCode}`).toContain(`'${p.phaseCode}'`);
    }
    for (const col of DEFAULT_PHASE_CONFIG.signboardColumns) {
      expect(sql, `thiếu cột ${col.taskCode}`).toContain(`'${col.taskCode}'`);
    }
    // Một luật có ký tự Nhật, chứng minh không bị hỏng mã hoá khi sinh.
    expect(sql).toContain("'受入テスト'");
  });

  it('idempotent và bọc trong transaction — chạy trực tiếp bằng psql an toàn', () => {
    const sql = renderDefaultConfigSql();
    expect(sql).toContain('BEGIN;');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    // Bỏ qua khi đã có bản GLOBAL hiệu lực (idempotent).
    expect(sql).toMatch(/IF EXISTS[\s\S]*scope = 'GLOBAL' AND is_active = TRUE[\s\S]*RETURN;/);
    // Lịch làm việc upsert, không nhân đôi.
    expect(sql).toContain('ON CONFLICT (calendar_id) DO UPDATE');
  });

  it('KHÔNG chèn giá trị vào cột compiled_regex NOT NULL bằng NULL', () => {
    // compiled_regex NOT NULL — phải là chuỗi rỗng, không phải NULL, nếu không
    // câu INSERT sẽ chết lúc chạy thật.
    const sql = renderDefaultConfigSql();
    expect(sql).toContain("'[Phase] {name}', '', 1");
  });
});
