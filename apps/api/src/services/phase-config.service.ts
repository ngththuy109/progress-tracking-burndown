import {
  EMPTY_CONFIG_PAYLOAD,
  RECOMPUTE_SECONDS_PER_EPIC,
  type ConfigPayload,
  type ConfigSet,
  type ConfigVersion,
  type EffectiveConfig,
  type Principal,
  type PreviewRequest,
  type PreviewResponse,
  type UnmatchedLabel,
  type ValidationIssue,
} from '@app/shared';
import { mergeInheritance, validateConfigPayload, hasBlockingError } from '@app/engine';
import { buildPreview, type PreviewTask } from './config-preview.service.js';

/**
 * Điều phối nhóm API cấu hình Phase — PRD §2.2.
 *
 * Mọi thứ bên ngoài (database, Redis) đi qua CỔNG khai báo dưới đây thay vì gọi
 * thẳng Prisma. Nhờ vậy toàn bộ logic này chạy được test mà không cần dựng
 * PostgreSQL — bộ test giữ được tốc độ, và người ta mới thật sự chạy nó (C-12).
 * Bộ chuyển đổi thật chỉ là lớp vỏ mỏng bọc repository của T-06.
 */

export interface PhaseConfigStore {
  findActive(scope: 'GLOBAL' | 'PROJECT', projectKey: string | null): Promise<ConfigSet | null>;
  save(args: {
    scope: 'GLOBAL' | 'PROJECT';
    projectKey: string | null;
    payload: ConfigPayload;
    createdBy: string;
    note: string | null;
  }): Promise<{ version: number; id: number }>;
  rollback(args: {
    scope: 'GLOBAL' | 'PROJECT';
    projectKey: string | null;
    version: number;
    createdBy: string;
  }): Promise<{ version: number; id: number }>;
  listVersions(
    scope: 'GLOBAL' | 'PROJECT',
    projectKey: string | null,
  ): Promise<readonly ConfigVersion[]>;
}

export interface IssueReadPort {
  /** Task (Phase) của project, hoặc của TẤT CẢ project khi `projectKey === null`. */
  listPhaseTasks(projectKey: string | null): Promise<readonly PreviewTask[]>;
  /** Nhãn bóc được từ tiêu đề nhưng không luật nào khớp, gom theo nhãn. */
  listUnmatchedLabels(projectKey: string | null): Promise<readonly UnmatchedLabel[]>;
  /** Epic đang theo dõi thuộc phạm vi này — để biết phải tính lại bao nhiêu. */
  listTrackedEpicKeys(projectKey: string | null): Promise<readonly string[]>;
}

export interface DirtyEpicQueue {
  /** Đánh dấu Epic cần tính lại. T-18 nhặt sau, KHÔNG tính ngay trong request. */
  add(epicKeys: readonly string[]): Promise<void>;
}

export interface PhaseConfigDeps {
  readonly store: PhaseConfigStore;
  readonly issues: IssueReadPort;
  readonly dirty: DirtyEpicQueue;
}

/** Lỗi có mã HTTP đi kèm, để tầng route không phải đoán. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly issues?: readonly ValidationIssue[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const scopeOf = (projectKey: string | null): 'GLOBAL' | 'PROJECT' =>
  projectKey === null ? 'GLOBAL' : 'PROJECT';

/**
 * Ai được sửa cấu hình nào.
 *
 * Bộ Mặc định (GLOBAL) chỉ Admin được đụng: nó ảnh hưởng tới MỌI project đang
 * kế thừa, nên một PM sửa nhầm sẽ làm đổi phân loại của cả những project họ
 * không phụ trách.
 */
export function assertCanWrite(principal: Principal, projectKey: string | null): void {
  if (principal.role === 'ADMIN') return;

  if (projectKey === null) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Only Admins can edit the Default settings, because they affect every project.',
    );
  }

  if (principal.role === 'PM' && principal.projects.includes(projectKey)) return;

  throw new ApiError(403, 'FORBIDDEN', `You do not have permission to edit the settings for project ${projectKey}.`);
}

/** Cấu hình đang hiệu lực, đã gộp kế thừa, kèm cờ `inherited` từng phần. */
export async function getEffective(
  deps: PhaseConfigDeps,
  projectKey: string | null,
): Promise<EffectiveConfig> {
  const global = await deps.store.findActive('GLOBAL', null);

  // Thiếu bộ Mặc định KHÔNG còn là lỗi chặn. Màn hình cấu hình vẫn mở bình
  // thường với một bộ RỖNG để admin tự định nghĩa Phase và cột Signboard từ đầu
  // rồi Lưu — thao tác đó tạo GLOBAL v1. `globalVersion = 0` báo cho UI biết
  // "chưa có bản nào".
  //
  // An toàn: engine/worker KHÔNG đi qua đường này. Chúng có đường riêng
  // (`loadEffectiveConfig` ở worker, fallback `DEFAULT_PHASE_CONFIG`), nên nới
  // đường ĐỌC cho UI cấu hình không kéo theo chuyện tính ra số từ cấu hình ảo.
  const globalPayload: ConfigPayload = global ?? EMPTY_CONFIG_PAYLOAD;
  const globalVersion = global?.version ?? 0;

  if (projectKey === null) {
    return mergeInheritance(globalPayload, null, {
      globalVersion,
      projectVersion: null,
    });
  }

  const project = await deps.store.findActive('PROJECT', projectKey);

  return mergeInheritance(globalPayload, project === null ? null : { ...project, projectKey }, {
    globalVersion,
    projectVersion: project?.version ?? null,
  });
}

/**
 * Xem thử — KHÔNG ghi bất cứ thứ gì.
 *
 * Chỉ dùng cổng ĐỌC (`store.findActive`, `issues.listPhaseTasks`). Không nhận
 * cổng ghi nào, nên không thể lỡ tay gọi `save`.
 */
export async function preview(
  deps: PhaseConfigDeps,
  req: PreviewRequest,
): Promise<PreviewResponse> {
  const global = await deps.store.findActive('GLOBAL', null);
  const tasks = await deps.issues.listPhaseTasks(req.projectKey);

  return buildPreview({
    projectKey: req.projectKey,
    draft: req.draft,
    globalConfig: global,
    tasks,
    limit: req.limit,
  });
}

/** Lưu version mới rồi đánh dấu Epic cần tính lại. */
export async function save(
  deps: PhaseConfigDeps,
  principal: Principal,
  args: { projectKey: string | null; payload: ConfigPayload; note: string | null },
): Promise<{ version: number; affectedEpics: number; estimatedRecomputeSeconds: number }> {
  assertCanWrite(principal, args.projectKey);

  const issues = validateConfigPayload(args.payload);
  if (hasBlockingError(issues)) {
    // Ném TRƯỚC khi gọi `store.save`. Nếu kiểm tra sau thì đã có version mới
    // nằm trong DB rồi mới báo lỗi.
    throw new ApiError(400, 'CONFIG_INVALID', 'The settings are not valid, so nothing was saved.', issues);
  }

  const { version } = await deps.store.save({
    scope: scopeOf(args.projectKey),
    projectKey: args.projectKey,
    payload: args.payload,
    createdBy: principal.userId,
    note: args.note,
  });

  const affected = await markDirty(deps, args.projectKey);

  return {
    version,
    affectedEpics: affected,
    estimatedRecomputeSeconds: affected * RECOMPUTE_SECONDS_PER_EPIC,
  };
}

/** Quay về version cũ. Cũng phải đánh dấu tính lại y như lưu mới. */
export async function rollback(
  deps: PhaseConfigDeps,
  principal: Principal,
  args: { projectKey: string | null; version: number },
): Promise<{ version: number; affectedEpics: number; estimatedRecomputeSeconds: number }> {
  assertCanWrite(principal, args.projectKey);

  const { version } = await deps.store.rollback({
    scope: scopeOf(args.projectKey),
    projectKey: args.projectKey,
    version: args.version,
    createdBy: principal.userId,
  });

  const affected = await markDirty(deps, args.projectKey);

  return {
    version,
    affectedEpics: affected,
    estimatedRecomputeSeconds: affected * RECOMPUTE_SECONDS_PER_EPIC,
  };
}

export function listVersions(
  deps: PhaseConfigDeps,
  projectKey: string | null,
): Promise<readonly ConfigVersion[]> {
  return deps.store.listVersions(scopeOf(projectKey), projectKey);
}

export function listUnmatched(
  deps: PhaseConfigDeps,
  projectKey: string | null,
): Promise<readonly UnmatchedLabel[]> {
  return deps.issues.listUnmatchedLabels(projectKey);
}

/**
 * Đẩy Epic vào hàng đợi tính lại rồi TRẢ VỀ NGAY.
 *
 * Tuyệt đối không tính lại ngay trong request: 50 Epic mất vài phút, request sẽ
 * timeout và PM tưởng thao tác thất bại rồi bấm Lưu lần nữa. T-18 nhặt hàng đợi
 * này và chạy nền.
 */
async function markDirty(deps: PhaseConfigDeps, projectKey: string | null): Promise<number> {
  const epicKeys = await deps.issues.listTrackedEpicKeys(projectKey);
  if (epicKeys.length > 0) await deps.dirty.add(epicKeys);
  return epicKeys.length;
}
