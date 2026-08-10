import type {
  ConfigPayload,
  ConfigSet,
  EffectiveConfig,
  HierarchyLevel,
  HierarchyProfile,
} from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Kho cấu hình nhận diện Phase — PRD §2.2.
 *
 * Version KHÔNG BAO GIỜ bị xoá: lưu bản mới là tạo version mới, bản cũ giữ
 * nguyên để quay lại được (US-09).
 */

export interface ConfigCache {
  del(pattern: string): Promise<void>;
}

export const CONFIG_CACHE_PREFIX = 'meta:phaseconfig';

/** Hình dạng dòng `hierarchy_profile` mà hai hàm dưới cùng dùng. */
interface HierarchyProfileRow {
  levels: unknown;
  phaseSourceType: string;
  phaseSourceRef: string | null;
  phaseGroupLevel: number | null;
  sbRowSource: string;
  sbRowRef: string;
  sbColSource: string;
  sbColRef: string;
}

/**
 * Dòng DB → `HierarchyProfile`. Các trường tuỳ chọn chỉ đưa vào khi CÓ —
 * `exactOptionalPropertyTypes` phân biệt "vắng mặt" với "bằng undefined".
 */
function profileFromRow(row: HierarchyProfileRow | null): HierarchyProfile | null {
  if (!row) return null;
  return {
    levels: row.levels as HierarchyLevel[],
    phaseSource: {
      type: row.phaseSourceType as HierarchyProfile['phaseSource']['type'],
      ref: row.phaseSourceRef,
      ...(row.phaseGroupLevel !== null ? { groupLevel: row.phaseGroupLevel } : {}),
    },
    signboard: {
      row: {
        source: row.sbRowSource as HierarchyProfile['signboard']['row']['source'],
        ref: row.sbRowRef,
      },
      column: {
        source: row.sbColSource as HierarchyProfile['signboard']['column']['source'],
        ref: row.sbColRef,
      },
    },
  };
}

export function configCacheKey(projectKey: string | null): string {
  return `${CONFIG_CACHE_PREFIX}:${projectKey ?? 'GLOBAL'}`;
}

/** Đọc một bộ cấu hình đang hiệu lực theo phạm vi. */
export async function findActiveConfigSet(
  prisma: PrismaClient,
  scope: 'GLOBAL' | 'PROJECT',
  projectKey: string | null,
): Promise<ConfigSet | null> {
  const row = await prisma.phaseConfigSet.findFirst({
    where: { scope, projectKey, isActive: true },
    include: {
      titlePatterns: { orderBy: { sortOrder: 'asc' } },
      subtaskTitlePatterns: { orderBy: { sortOrder: 'asc' } },
      phaseDefinitions: { orderBy: { displayOrder: 'asc' } },
      matchRules: { orderBy: { matchPriority: 'asc' } },
      signboardColumns: { orderBy: { displayOrder: 'asc' } },
      hierarchyProfile: true,
    },
  });
  if (!row) return null;

  return {
    id: Number(row.id),
    scope: row.scope as 'GLOBAL' | 'PROJECT',
    projectKey: row.projectKey,
    version: row.version,
    isActive: row.isActive,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    note: row.note,

    fallbackScanFullTitle: row.fallbackScanFullTitle,
    titlePatterns: row.titlePatterns.map((p) => ({
      patternText: p.patternText,
      sortOrder: p.sortOrder,
    })),
    subtaskPatterns: row.subtaskTitlePatterns.map((p) => ({
      patternText: p.patternText,
      sortOrder: p.sortOrder,
    })),
    phaseDefinitions: row.phaseDefinitions.map((p) => ({
      phaseCode: p.phaseCode,
      labelVi: p.labelVi,
      labelJa: p.labelJa,
      colorHex: p.colorHex,
      displayOrder: p.displayOrder,
    })),
    matchRules: row.matchRules.map((r) => ({
      keyword: r.keyword,
      matchMode: r.matchMode as 'CONTAINS' | 'REGEX',
      phaseCode: r.phaseCode,
      matchPriority: r.matchPriority,
    })),
    signboardColumns: row.signboardColumns.map((c) => ({
      taskCode: c.taskCode,
      labelVi: c.labelVi,
      labelJa: c.labelJa,
      displayOrder: c.displayOrder,
    })),
    hierarchyProfile: profileFromRow(row.hierarchyProfile),
  };
}

/**
 * Lưu một bộ cấu hình thành VERSION MỚI.
 *
 * Toàn bộ nằm trong MỘT transaction: tách ra hai lệnh thì có khoảnh khắc không
 * bản nào active (hoặc hai bản cùng active) — partial unique index sẽ ném lỗi
 * giữa chừng và để lại dữ liệu dở dang.
 *
 * KHÔNG kiểm tra hợp lệ ở đây — việc đó do `validateConfigPayload` của engine
 * làm, và tầng API gọi trước khi vào đây.
 */
export async function saveNewVersion(
  prisma: PrismaClient,
  args: {
    scope: 'GLOBAL' | 'PROJECT';
    projectKey: string | null;
    payload: ConfigPayload;
    createdBy: string;
    note?: string | null;
  },
  cache?: ConfigCache,
): Promise<{ version: number; id: number }> {
  const { scope, projectKey, payload, createdBy } = args;

  const result = await prisma.$transaction(async (tx) => {
    const max = await tx.phaseConfigSet.aggregate({
      where: { scope, projectKey },
      _max: { version: true },
    });
    const version = (max._max.version ?? 0) + 1;

    await tx.phaseConfigSet.updateMany({
      where: { scope, projectKey, isActive: true },
      data: { isActive: false },
    });

    const created = await tx.phaseConfigSet.create({
      data: {
        scope,
        projectKey,
        version,
        isActive: true,
        fallbackScanFullTitle: payload.fallbackScanFullTitle,
        createdBy,
        note: args.note ?? null,
        titlePatterns: {
          create: payload.titlePatterns.map((p) => ({
            patternText: p.patternText,
            // Regex thật do engine sinh (T-07). Ở đây lưu chuỗi rỗng làm chỗ giữ
            // — T-07 sẽ cập nhật khi biên dịch mẫu.
            compiledRegex: '',
            sortOrder: p.sortOrder,
          })),
        },
        subtaskTitlePatterns: {
          create: payload.subtaskPatterns.map((p) => ({
            patternText: p.patternText,
            compiledRegex: '',
            sortOrder: p.sortOrder,
          })),
        },
        phaseDefinitions: {
          create: payload.phaseDefinitions.map((p) => ({
            phaseCode: p.phaseCode,
            labelVi: p.labelVi,
            labelJa: p.labelJa ?? null,
            colorHex: p.colorHex ?? null,
            displayOrder: p.displayOrder,
          })),
        },
        matchRules: {
          create: payload.matchRules.map((r) => ({
            keyword: r.keyword,
            matchMode: r.matchMode,
            phaseCode: r.phaseCode,
            matchPriority: r.matchPriority,
          })),
        },
        signboardColumns: {
          create: payload.signboardColumns.map((c) => ({
            taskCode: c.taskCode,
            labelVi: c.labelVi,
            labelJa: c.labelJa ?? null,
            displayOrder: c.displayOrder,
          })),
        },
        // KHÔNG khai profile = không có dòng — đường đọc rơi về profile mặc
        // định 3 tầng, xem `hierarchy_profile` trong schema.prisma.
        ...(payload.hierarchyProfile
          ? {
              hierarchyProfile: {
                create: {
                  levels: payload.hierarchyProfile.levels,
                  phaseSourceType: payload.hierarchyProfile.phaseSource.type,
                  phaseSourceRef: payload.hierarchyProfile.phaseSource.ref ?? null,
                  phaseGroupLevel: payload.hierarchyProfile.phaseSource.groupLevel ?? null,
                  sbRowSource: payload.hierarchyProfile.signboard.row.source,
                  sbRowRef: payload.hierarchyProfile.signboard.row.ref,
                  sbColSource: payload.hierarchyProfile.signboard.column.source,
                  sbColRef: payload.hierarchyProfile.signboard.column.ref,
                },
              },
            }
          : {}),
      },
    });

    return { version, id: Number(created.id) };
  });

  await invalidateConfigCache(cache, scope, projectKey);
  return result;
}

/**
 * Quay về một version cũ bằng cách TẠO VERSION MỚI có nội dung y hệt.
 *
 * KHÔNG sửa `is_active` của version cũ trực tiếp — làm vậy là viết lại lịch sử
 * và không giải thích được với người dùng (US-09).
 */
export async function rollbackToVersion(
  prisma: PrismaClient,
  args: {
    scope: 'GLOBAL' | 'PROJECT';
    projectKey: string | null;
    version: number;
    createdBy: string;
  },
  cache?: ConfigCache,
): Promise<{ version: number; id: number }> {
  const old = await prisma.phaseConfigSet.findFirst({
    where: { scope: args.scope, projectKey: args.projectKey, version: args.version },
    include: {
      titlePatterns: { orderBy: { sortOrder: 'asc' } },
      subtaskTitlePatterns: { orderBy: { sortOrder: 'asc' } },
      phaseDefinitions: { orderBy: { displayOrder: 'asc' } },
      matchRules: { orderBy: { matchPriority: 'asc' } },
      signboardColumns: { orderBy: { displayOrder: 'asc' } },
      hierarchyProfile: true,
    },
  });

  if (!old) {
    throw new Error(
      `Không tìm thấy version ${args.version} của phạm vi ` +
        `${args.scope}${args.projectKey ? `:${args.projectKey}` : ''}.`,
    );
  }

  return saveNewVersion(
    prisma,
    {
      scope: args.scope,
      projectKey: args.projectKey,
      createdBy: args.createdBy,
      note: `Quay lại nội dung của version ${args.version}`,
      payload: {
        fallbackScanFullTitle: old.fallbackScanFullTitle,
        titlePatterns: old.titlePatterns.map((p) => ({
          patternText: p.patternText,
          sortOrder: p.sortOrder,
        })),
        subtaskPatterns: old.subtaskTitlePatterns.map((p) => ({
          patternText: p.patternText,
          sortOrder: p.sortOrder,
        })),
        phaseDefinitions: old.phaseDefinitions.map((p) => ({
          phaseCode: p.phaseCode,
          labelVi: p.labelVi,
          labelJa: p.labelJa,
          colorHex: p.colorHex,
          displayOrder: p.displayOrder,
        })),
        matchRules: old.matchRules.map((r) => ({
          keyword: r.keyword,
          matchMode: r.matchMode as 'CONTAINS' | 'REGEX',
          phaseCode: r.phaseCode,
          matchPriority: r.matchPriority,
        })),
        signboardColumns: old.signboardColumns.map((c) => ({
          taskCode: c.taskCode,
          labelVi: c.labelVi,
          labelJa: c.labelJa,
          displayOrder: c.displayOrder,
        })),
        hierarchyProfile: profileFromRow(old.hierarchyProfile),
      },
    },
    cache,
  );
}

export async function listVersions(
  prisma: PrismaClient,
  scope: 'GLOBAL' | 'PROJECT',
  projectKey: string | null,
): Promise<Array<Pick<ConfigSet, 'version' | 'isActive' | 'createdBy' | 'createdAt' | 'note'>>> {
  const rows = await prisma.phaseConfigSet.findMany({
    where: { scope, projectKey },
    orderBy: { version: 'desc' },
    select: { version: true, isActive: true, createdBy: true, createdAt: true, note: true },
  });
  return rows.map((r) => ({
    version: r.version,
    isActive: r.isActive,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    note: r.note,
  }));
}

/**
 * Xoá cache NGAY khi lưu, không đợi hết TTL 1 giờ.
 *
 * Để PM sửa xong mà cả tiếng sau mới có hiệu lực thì họ sẽ tưởng hệ thống hỏng
 * và sửa đi sửa lại (PRD §4.7).
 *
 * Sửa bộ Mặc định phải xoá cache của TẤT CẢ project, vì project nào cũng có thể
 * đang kế thừa từ nó.
 */
export async function invalidateConfigCache(
  cache: ConfigCache | undefined,
  scope: 'GLOBAL' | 'PROJECT',
  projectKey: string | null,
): Promise<void> {
  if (!cache) return;
  await cache.del(scope === 'GLOBAL' ? `${CONFIG_CACHE_PREFIX}:*` : configCacheKey(projectKey));
}

/** Kiểu trả về của `getEffectiveConfig`, gộp sẵn cho tầng API. */
export type { EffectiveConfig };
