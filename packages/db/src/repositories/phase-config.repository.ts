import type {
  ConfigPayload,
  ConfigSet,
  EffectiveConfig,
  GroupSourceType,
  GroupTier,
  GroupTierRole,
} from '@app/shared';
import { deriveDefaultTiersFromPhase } from '@app/shared';
import { Prisma } from '../client.js';
import type { PrismaClient } from '../client.js';

/**
 * Gom các hàng group_tier* (phẳng, keyed theo tier_order) thành vectơ `GroupTier`.
 * Dùng chung cho `findActiveConfigSet` và `rollbackToVersion`.
 */
function assembleTiers(row: {
  readonly groupTiers: readonly {
    tierOrder: number; code: string; labelVi: string; labelJa: string | null;
    role: string; sourceType: string; sourceConfig: unknown; displayOrder: number;
  }[];
  readonly groupTierDefinitions: readonly {
    tierOrder: number; groupCode: string; labelVi: string; labelJa: string | null;
    colorHex: string | null; displayOrder: number;
  }[];
  readonly groupTierRules: readonly {
    tierOrder: number; keyword: string; matchMode: string; groupCode: string; matchPriority: number;
  }[];
  readonly groupTierTitlePatterns: readonly {
    tierOrder: number; patternText: string; sortOrder: number;
  }[];
}): GroupTier[] {
  return row.groupTiers.map((t) => ({
    tierOrder: t.tierOrder,
    code: t.code,
    labelVi: t.labelVi,
    labelJa: t.labelJa,
    role: t.role as GroupTierRole,
    sourceType: t.sourceType as GroupSourceType,
    sourceConfig: (t.sourceConfig as Record<string, unknown> | null) ?? null,
    definitions: row.groupTierDefinitions
      .filter((d) => d.tierOrder === t.tierOrder)
      .map((d) => ({ groupCode: d.groupCode, labelVi: d.labelVi, labelJa: d.labelJa, colorHex: d.colorHex, displayOrder: d.displayOrder })),
    rules: row.groupTierRules
      .filter((r) => r.tierOrder === t.tierOrder)
      .map((r) => ({ keyword: r.keyword, matchMode: r.matchMode as 'CONTAINS' | 'REGEX', groupCode: r.groupCode, matchPriority: r.matchPriority })),
    titlePatterns: row.groupTierTitlePatterns
      .filter((p) => p.tierOrder === t.tierOrder)
      .map((p) => ({ patternText: p.patternText, sortOrder: p.sortOrder })),
    displayOrder: t.displayOrder,
  }));
}

/** Object JSON hoặc SQL NULL cho cột JSONB nullable (`source_config`). */
function jsonOrNull(v: Record<string, unknown> | null | undefined) {
  return v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue);
}

/**
 * Dựng phần nested-create cho group_tier* từ danh sách tầng.
 *
 * `source_config` (tham số của source: tên token, tiền tố label…) được ghi để Config
 * API/UI round-trip đủ. `compiled_regex` để rỗng — engine sinh sau (như phase_*).
 */
function tierCreateData(tiers: readonly GroupTier[]) {
  return {
    groupTiers: {
      create: tiers.map((t) => ({
        tierOrder: t.tierOrder,
        code: t.code,
        labelVi: t.labelVi,
        labelJa: t.labelJa ?? null,
        role: t.role,
        sourceType: t.sourceType,
        sourceConfig: jsonOrNull(t.sourceConfig),
        displayOrder: t.displayOrder,
      })),
    },
    groupTierDefinitions: {
      create: tiers.flatMap((t) =>
        t.definitions.map((d) => ({
          tierOrder: t.tierOrder,
          groupCode: d.groupCode,
          labelVi: d.labelVi,
          labelJa: d.labelJa ?? null,
          colorHex: d.colorHex ?? null,
          displayOrder: d.displayOrder,
        })),
      ),
    },
    groupTierRules: {
      create: tiers.flatMap((t) =>
        t.rules.map((r) => ({
          tierOrder: t.tierOrder,
          keyword: r.keyword,
          matchMode: r.matchMode,
          groupCode: r.groupCode,
          matchPriority: r.matchPriority,
        })),
      ),
    },
    groupTierTitlePatterns: {
      create: tiers.flatMap((t) =>
        t.titlePatterns.map((p) => ({
          tierOrder: t.tierOrder,
          patternText: p.patternText,
          compiledRegex: '',
          sortOrder: p.sortOrder,
        })),
      ),
    },
  };
}

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
      subPhaseOrders: { orderBy: [{ phaseCode: 'asc' }, { displayOrder: 'asc' }] },
      groupTiers: { orderBy: { tierOrder: 'asc' } },
      groupTierDefinitions: { orderBy: [{ tierOrder: 'asc' }, { displayOrder: 'asc' }] },
      groupTierRules: { orderBy: [{ tierOrder: 'asc' }, { matchPriority: 'asc' }] },
      groupTierTitlePatterns: { orderBy: [{ tierOrder: 'asc' }, { sortOrder: 'asc' }] },
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
      side: c.side as 'VN' | 'JP',
      displayOrder: c.displayOrder,
    })),
    subPhaseOrders: row.subPhaseOrders.map((s) => ({
      phaseCode: s.phaseCode,
      subPhaseCode: s.subPhaseCode,
      displayOrder: s.displayOrder,
    })),
    tiers: assembleTiers(row),
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

  // Vắng/rỗng → sinh MIRROR "một tầng Phase" từ phase config (Vòng 1: không đổi hành vi).
  const tiers =
    payload.tiers && payload.tiers.length > 0 ? payload.tiers : deriveDefaultTiersFromPhase(payload);

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
            side: c.side,
            displayOrder: c.displayOrder,
          })),
        },
        subPhaseOrders: {
          create: payload.subPhaseOrders.map((s) => ({
            phaseCode: s.phaseCode,
            subPhaseCode: s.subPhaseCode,
            displayOrder: s.displayOrder,
          })),
        },
        ...tierCreateData(tiers),
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
      subPhaseOrders: { orderBy: [{ phaseCode: 'asc' }, { displayOrder: 'asc' }] },
      groupTiers: { orderBy: { tierOrder: 'asc' } },
      groupTierDefinitions: { orderBy: [{ tierOrder: 'asc' }, { displayOrder: 'asc' }] },
      groupTierRules: { orderBy: [{ tierOrder: 'asc' }, { matchPriority: 'asc' }] },
      groupTierTitlePatterns: { orderBy: [{ tierOrder: 'asc' }, { sortOrder: 'asc' }] },
    },
  });

  if (!old) {
    throw new Error(
      `Version ${args.version} of scope ` +
        `${args.scope}${args.projectKey ? `:${args.projectKey}` : ''} was not found.`,
    );
  }

  return saveNewVersion(
    prisma,
    {
      scope: args.scope,
      projectKey: args.projectKey,
      createdBy: args.createdBy,
      note: `Reverted to the content of version ${args.version}`,
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
          side: c.side as 'VN' | 'JP',
          displayOrder: c.displayOrder,
        })),
        subPhaseOrders: old.subPhaseOrders.map((s) => ({
          phaseCode: s.phaseCode,
          subPhaseCode: s.subPhaseCode,
          displayOrder: s.displayOrder,
        })),
        tiers: assembleTiers(old),
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
