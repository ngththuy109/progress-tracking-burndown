import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertMigrationsApplied,
  defaultMigrationsDir,
  fetchAppliedMigrationNames,
  findPendingMigrations,
  listMigrationDirNames,
  PendingMigrationsError,
} from './migration-status.js';
import { DB_SKIP_REASON, hasDatabase } from './test-helpers.js';

// ===========================================================================
// Phần thuần — chạy KHÔNG cần database.
// ===========================================================================

describe('findPendingMigrations', () => {
  it('rỗng khi mọi migration trên đĩa đều đã áp', () => {
    const onDisk = ['20260803000000_init', '20260810000000_sub_phase_order'];
    expect(findPendingMigrations(onDisk, new Set(onDisk))).toEqual([]);
  });

  it('trả về TẤT CẢ khi chưa áp gì (database trắng)', () => {
    const onDisk = ['20260803000000_init', '20260811000000_signboard_column_side'];
    expect(findPendingMigrations(onDisk, new Set())).toEqual(onDisk);
  });

  it('chỉ trả về phần chưa áp, giữ nguyên thứ tự đĩa', () => {
    const onDisk = [
      '20260803000000_init',
      '20260810000000_sub_phase_order',
      '20260811000000_signboard_column_side',
    ];
    const applied = new Set(['20260803000000_init']);
    expect(findPendingMigrations(onDisk, applied)).toEqual([
      '20260810000000_sub_phase_order',
      '20260811000000_signboard_column_side',
    ]);
  });

  it('bỏ qua migration DB có mà đĩa không có (không thuộc phạm vi guard)', () => {
    const onDisk = ['20260803000000_init'];
    const applied = new Set(['20260803000000_init', '29990101000000_from_the_future']);
    expect(findPendingMigrations(onDisk, applied)).toEqual([]);
  });
});

describe('listMigrationDirNames', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mig-status-'));
    // Hai thư mục hợp lệ (có migration.sql), tạo lệch thứ tự để kiểm việc sắp xếp.
    for (const name of ['20260810000000_b', '20260803000000_a']) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'migration.sql'), '-- noop\n');
    }
    // Thư mục KHÔNG có migration.sql → bỏ qua (ca `migration_lock.toml` cạnh đó…).
    mkdirSync(join(dir, '20260899000000_no_sql'));
    // File lẻ ở gốc → bỏ qua (không phải thư mục).
    writeFileSync(join(dir, 'migration_lock.toml'), 'provider = "postgresql"\n');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('chỉ lấy thư mục có migration.sql, sắp theo tên', () => {
    expect(listMigrationDirNames(dir)).toEqual(['20260803000000_a', '20260810000000_b']);
  });

  it('thư mục không tồn tại → mảng rỗng, không ném', () => {
    expect(listMigrationDirNames(join(dir, 'khong-co'))).toEqual([]);
  });

  it('defaultMigrationsDir() trỏ tới migrations thật của repo', () => {
    // Migration init luôn có mặt — chốt rằng đường dẫn theo import.meta.url đúng.
    expect(listMigrationDirNames(defaultMigrationsDir())).toContain('20260803000000_init');
  });
});

describe('PendingMigrationsError', () => {
  it('nêu tên migration thiếu và đúng lệnh phải chạy', () => {
    const err = new PendingMigrationsError(['20260811000000_signboard_column_side']);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('20260811000000_signboard_column_side');
    expect(err.message).toContain('pnpm db:migrate');
    expect(err.pending).toEqual(['20260811000000_signboard_column_side']);
  });
});

describe('assertMigrationsApplied — không có DB vẫn kiểm được vài nhánh', () => {
  it('thư mục migrations không tồn tại → bỏ qua (không báo động giả), gọi onSkip', async () => {
    let skipped: { reason: string; dir: string } | undefined;
    // `prisma` không được chạm tới ở nhánh này nên truyền một object trơ là đủ.
    await assertMigrationsApplied({} as never, {
      migrationsDir: join(tmpdir(), 'chac-chan-khong-ton-tai-xyz'),
      onSkip: (reason, dir) => (skipped = { reason, dir }),
    });
    expect(skipped?.reason).toBe('migrations-dir-not-found');
  });
});

// ===========================================================================
// Phần ràng buộc DB — chạy đầy đủ ở CI (đã `pnpm db:migrate` trước `pnpm test`).
// ===========================================================================

describe('migration-status trên PostgreSQL thật', async () => {
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

  it('fetchAppliedMigrationNames đọc được từ _prisma_migrations', async () => {
    const applied = await fetchAppliedMigrationNames(prisma);
    // CI migrate đầy đủ trước khi test nên init phải nằm trong đó.
    expect(applied.has('20260803000000_init')).toBe(true);
  });

  it('assertMigrationsApplied KHÔNG ném khi DB đã migrate đủ (thư mục thật)', async () => {
    await expect(assertMigrationsApplied(prisma)).resolves.toBeUndefined();
  });

  it('ném PendingMigrationsError khi đĩa có migration DB chưa áp', async () => {
    // Thư mục tạm chứa MỘT migration chắc chắn chưa từng áp trên DB thật.
    const dir = mkdtempSync(join(tmpdir(), 'mig-pending-'));
    mkdirSync(join(dir, '29990101000000_never_applied'));
    writeFileSync(join(dir, '29990101000000_never_applied', 'migration.sql'), '-- noop\n');
    try {
      await expect(assertMigrationsApplied(prisma, { migrationsDir: dir })).rejects.toBeInstanceOf(
        PendingMigrationsError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
