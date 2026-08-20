import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@app/db';
import type { WorkSide } from '@app/shared';
import { createOpsHealthPort } from './ops.adapters.js';
import type { PlanConflictReadPort } from '../routes/plan-conflicts.routes.js';

/**
 * Bug "Data quality hiện 4 dòng trong khi chỉ có 3 Epic đang active".
 *
 * Câu SQL tách Data quality theo Epic đọc từ `tracked_epic` mà KHÔNG lọc
 * `status = 'ACTIVE'`, lại LEFT JOIN sang `jira_issue`. Vì thế MỌI Epic trong
 * sổ — kể cả PENDING/BACKFILLING/PAUSED/ERROR — đều sinh một dòng (dòng "ma"
 * total=0 khi Epic chưa có sub-task). Số "Epics behind on snapshots" ngay cạnh
 * đó lại lọc ACTIVE, nên hai con số lệch nhau và người trực thấy dư một dòng.
 *
 * Test đi qua CHÍNH adapter production `createOpsHealthPort`, với Prisma giả chỉ
 * mô phỏng đúng một chiều đang kiểm — lọc Epic theo `status`. `$queryRawUnsafe`
 * đọc chính câu SQL sản xuất: có `status = 'ACTIVE'` thì trả Epic ACTIVE, thiếu
 * thì trả tất cả (đúng hành vi bug cũ) — nên test đỏ nếu ai gỡ bộ lọc. Chạy được
 * không cần PostgreSQL.
 */

interface SeedEpic {
  readonly epicKey: string;
  readonly displayName: string;
  readonly status: string;
}

const SEED: readonly SeedEpic[] = [
  { epicKey: 'PAY-1', displayName: 'Payment', status: 'ACTIVE' },
  { epicKey: 'CRM-1', displayName: 'CRM', status: 'ACTIVE' },
  { epicKey: 'SHOP-1', displayName: 'Shop', status: 'ACTIVE' },
  // Thủ phạm "dòng thứ tư": đã tạm dừng nên job đêm không còn đồng bộ.
  { epicKey: 'OLD-9', displayName: 'Đã tạm dừng', status: 'PAUSED' },
];

function byEpicRow(e: SeedEpic) {
  return {
    epic_key: e.epicKey,
    display_name: e.displayName,
    total: 10n,
    no_estimate: 0n,
    unclassified: 0n,
    no_wbs: 0n,
    unparsed: 0n,
    closed_no_worklog: 0n,
  };
}

function fakePrisma() {
  const sqls: string[] = [];
  const prisma = {
    $queryRawUnsafe: (sql: string) => {
      sqls.push(sql);
      // Câu tách theo Epic — nơi bug nằm. Mô phỏng Postgres lọc theo status.
      if (sql.includes('GROUP BY te.epic_key')) {
        const activeOnly = /te\.status\s*=\s*'ACTIVE'/.test(sql);
        const rows = SEED.filter((e) => !activeOnly || e.status === 'ACTIVE').map(byEpicRow);
        return Promise.resolve(rows);
      }
      // Các số đo khác không thuộc phạm vi test này → rỗng là đủ để opsHealth() chạy trọn.
      return Promise.resolve([]);
    },
  } as unknown as PrismaClient;
  return { prisma, sqls };
}

// Không có Epic nào cho hệ plan-conflicts → không tính lỗi plan-ngày-nghỉ, đủ để
// opsHealth() chạy trọn mà không đụng Prisma thật ở nhánh đó.
const noPlanConflicts: PlanConflictReadPort = {
  epicMeta: () => Promise.resolve(null),
  listEpics: () => Promise.resolve([]),
  subtasksForCheck: () => Promise.resolve([]),
  columnSides: () => Promise.resolve(new Map<string, WorkSide>()),
  sideCalendar: () => Promise.reject(new Error('sideCalendar không được gọi khi không có Epic')),
};

describe('createOpsHealthPort.opsHealth — Data quality theo Epic CHỈ tính Epic ACTIVE', () => {
  it('bỏ Epic không ACTIVE: số dòng khớp số Epic đang active, không dư dòng "ma"', async () => {
    const { prisma } = fakePrisma();
    const port = createOpsHealthPort(prisma, { planConflictReads: noPlanConflicts });

    const res = await port.opsHealth();
    const keys = res.data.byEpic.map((e) => e.epicKey);

    // Ba Epic ACTIVE (đã sắp theo epicKey vì mọi số đo đều OK), KHÔNG có OLD-9.
    expect(keys).toEqual(['CRM-1', 'PAY-1', 'SHOP-1']);
    expect(keys).not.toContain('OLD-9');
    expect(res.data.byEpic).toHaveLength(3);
  });

  it('câu SQL byEpic lọc ACTIVE — cùng phạm vi với số "Epics behind on snapshots"', async () => {
    const { prisma, sqls } = fakePrisma();
    const port = createOpsHealthPort(prisma, { planConflictReads: noPlanConflicts });
    await port.opsHealth();

    const byEpicSql = sqls.find((s) => s.includes('GROUP BY te.epic_key'));
    const snapshotSql = sqls.find((s) => s.includes('AS behind'));
    // Hai số đo cạnh nhau trên dashboard phải cùng nói về "Epic đang active".
    expect(byEpicSql).toMatch(/te\.status\s*=\s*'ACTIVE'/);
    expect(snapshotSql).toMatch(/status\s*=\s*'ACTIVE'/);
  });
});
