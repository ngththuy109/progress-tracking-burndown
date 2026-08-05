import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasDatabase, DB_SKIP_REASON } from './test-helpers.js';
import { DEFAULT_CALENDARS, WORKDAYS_MON_TO_FRI } from './seed/work-calendar.seed.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS_DIR = join(PKG_ROOT, 'prisma', 'migrations');

function readInitMigration(): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((d) => d.endsWith('_init'));
  if (!dir) throw new Error('Không tìm thấy migration _init');
  return readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
}

// ===========================================================================
// Nhóm 1 — Kiểm tra migration SQL bằng cách đọc file.
//
// Chạy được KHÔNG CẦN database. Mục đích: bắt ngay khi ai đó chạy
// `prisma migrate diff` sinh lại migration và làm rơi mất phần SQL thô —
// Prisma không sinh được partial index và CHECK constraint, nên chúng rất dễ
// biến mất im lặng và schema vẫn tạo được bình thường.
// ===========================================================================
describe('migration init — các lớp bảo vệ Prisma không tự sinh được', () => {
  const sql = readInitMigration();

  it('tạo đủ 16 bảng theo PRD §4.6', () => {
    const tables = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(tables).toEqual(
      expect.arrayContaining([
        'jira_issue',
        'issue_changelog_event',
        'worklog_entry',
        'tracked_epic',
        'daily_snapshot',
        'sync_run',
        'phase_config_set',
        'phase_title_pattern',
        'phase_definition',
        'phase_match_rule',
        'subtask_title_pattern',
        'signboard_column',
        'work_calendar',
        'calendar_holiday',
        'phase_rollup',
        'plan_shift_history',
      ]),
    );
    expect(tables).toHaveLength(16);
  });

  it('mỗi phạm vi cấu hình chỉ có một bản is_active — partial unique index', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "idx_config_active_global"[\s\S]*?WHERE is_active AND scope = 'GLOBAL'/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "idx_config_active_project"[\s\S]*?WHERE is_active AND scope = 'PROJECT'/,
    );
  });

  it('có partial index cho truy vấn Signboard', () => {
    expect(sql).toMatch(
      /CREATE INDEX "idx_issue_signboard"[\s\S]*?WHERE issue_type = 'SUBTASK' AND removed_at IS NULL/,
    );
  });

  it('có partial index phát hiện log giờ lùi ngày', () => {
    expect(sql).toMatch(
      /CREATE INDEX "idx_worklog_retro"[\s\S]*?WHERE started_at < created_at - INTERVAL '1 day'/,
    );
  });

  it('trạng thái Epic bị chặn bằng CHECK constraint, đủ 5 giá trị', () => {
    expect(sql).toMatch(
      /ck_epic_status[\s\S]*?CHECK \(status IN \('PENDING','BACKFILLING','ACTIVE','PAUSED','ERROR'\)\)/,
    );
  });

  it('scope GLOBAL bắt buộc project_key NULL, và ngược lại', () => {
    expect(sql).toMatch(/ck_config_scope/);
    expect(sql).toMatch(/scope = 'GLOBAL'\s+AND project_key IS NULL/);
    expect(sql).toMatch(/scope = 'PROJECT' AND project_key IS NOT NULL/);
  });

  it('daily_snapshot có source_read_at để chống ghi đè bằng dữ liệu cũ (E-19)', () => {
    expect(sql).toMatch(/"source_read_at" TIMESTAMPTZ/);
  });

  it('jira_issue có function_key để gộp hàng Signboard (E-31)', () => {
    expect(sql).toMatch(/"function_key" VARCHAR\(128\)/);
  });

  it('chống nhân đôi snapshot bằng UNIQUE (epic_key, snapshot_date)', () => {
    expect(sql).toMatch(/uq_snapshot[\s\S]*?"epic_key", "snapshot_date"/);
  });

  it('chống nhân đôi changelog bằng UNIQUE ba cột', () => {
    expect(sql).toMatch(/uq_changelog[\s\S]*?"issue_key", "jira_history_id", "field_name"/);
  });

  it('có kịch bản rollback đi kèm (CONVENTIONS.md C-13)', () => {
    const dir = readdirSync(MIGRATIONS_DIR).find((d) => d.endsWith('_init'))!;
    const rollback = readFileSync(join(MIGRATIONS_DIR, dir, 'ROLLBACK.sql'), 'utf8');
    // Xoá ngược thứ tự tạo: phase_rollup phải bị xoá TRƯỚC tracked_epic,
    // tracked_epic trước work_calendar — nếu không sẽ vướng khoá ngoại.
    expect(rollback.indexOf('DROP TABLE IF EXISTS "phase_rollup"')).toBeLessThan(
      rollback.indexOf('DROP TABLE IF EXISTS "tracked_epic"'),
    );
    expect(rollback.indexOf('DROP TABLE IF EXISTS "tracked_epic"')).toBeLessThan(
      rollback.indexOf('DROP TABLE IF EXISTS "work_calendar"'),
    );
  });
});

// ===========================================================================
// Nhóm 2 — Hằng số seed. Không cần database.
// ===========================================================================
describe('seed lịch làm việc', () => {
  it('có đúng hai lịch mặc định VN và JP', () => {
    expect(DEFAULT_CALENDARS.map((c) => c.calendarId)).toEqual(['VN_STANDARD', 'JP_STANDARD']);
  });

  it('múi giờ là chuỗi IANA hợp lệ, không phải offset dạng số', () => {
    for (const cal of DEFAULT_CALENDARS) {
      expect(cal.timezone).toMatch(/^[A-Z][a-z]+\/[A-Za-z_]+$/);
      expect(() => new Intl.DateTimeFormat('en', { timeZone: cal.timezone })).not.toThrow();
    }
  });

  it('bitmask T2–T6 bằng 31, bit 0 là Thứ Hai theo cách đánh số của luxon', () => {
    expect(WORKDAYS_MON_TO_FRI).toBe(31);
    // Thứ Bảy (bit 5) và Chủ nhật (bit 6) phải tắt
    expect(WORKDAYS_MON_TO_FRI & (1 << 5)).toBe(0);
    expect(WORKDAYS_MON_TO_FRI & (1 << 6)).toBe(0);
    // Thứ Hai (bit 0) tới Thứ Sáu (bit 4) phải bật
    for (let bit = 0; bit <= 4; bit++) {
      expect(WORKDAYS_MON_TO_FRI & (1 << bit)).not.toBe(0);
    }
  });
});

// ===========================================================================
// Nhóm 3 — Ràng buộc thật trên PostgreSQL.
//
// Cần DATABASE_URL dùng được. Bỏ qua có kiểm soát ở máy chưa có DB; CI luôn
// có service PostgreSQL nên nhóm này chạy đầy đủ ở đó.
// ===========================================================================
describe('ràng buộc thật trên PostgreSQL', async () => {
  const available = await hasDatabase();

  if (!available) {
    it.skip(`(${DB_SKIP_REASON})`, () => {});
    return;
  }

  let prisma: import('./client.js').PrismaClient;

  beforeAll(async () => {
    const { getPrisma } = await import('./client.js');
    prisma = getPrisma();
  });

  afterAll(async () => {
    const { disconnectPrisma } = await import('./client.js');
    await disconnectPrisma();
  });

  it('không thể thêm 2 bộ cấu hình GLOBAL cùng is_active', async () => {
    await prisma.phaseConfigSet.deleteMany({ where: { scope: 'GLOBAL' } });
    await prisma.phaseConfigSet.create({
      data: { scope: 'GLOBAL', version: 1, isActive: true, createdBy: 'test' },
    });
    await expect(
      prisma.phaseConfigSet.create({
        data: { scope: 'GLOBAL', version: 2, isActive: true, createdBy: 'test' },
      }),
    ).rejects.toThrow();
  });

  it('scope GLOBAL mà có project_key thì bị CHECK constraint chặn', async () => {
    await expect(
      prisma.phaseConfigSet.create({
        data: { scope: 'GLOBAL', projectKey: 'PAY', version: 99, createdBy: 'test' },
      }),
    ).rejects.toThrow();
  });

  it('trạng thái Epic lạ bị CHECK constraint chặn', async () => {
    const { seedWorkCalendars } = await import('./seed/work-calendar.seed.js');
    await seedWorkCalendars(prisma);
    await expect(
      prisma.$executeRaw`
        INSERT INTO tracked_epic (epic_key, epic_id, project_key, display_name, status,
                                  timezone, calendar_id, added_by)
        VALUES ('X-1', 999001, 'X', 'test', 'FOO', 'Asia/Ho_Chi_Minh', 'VN_STANDARD', 'test')
      `,
    ).rejects.toThrow();
  });

  it('seed lịch làm việc chạy 2 lần không nhân đôi', async () => {
    const { seedWorkCalendars } = await import('./seed/work-calendar.seed.js');
    await seedWorkCalendars(prisma);
    await seedWorkCalendars(prisma);
    const count = await prisma.workCalendar.count({
      where: { calendarId: { in: ['VN_STANDARD', 'JP_STANDARD'] } },
    });
    expect(count).toBe(2);
  });
});
