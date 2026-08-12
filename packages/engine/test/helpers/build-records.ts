import {
  DEFAULT_HOURS_PER_DAY,
  DEFAULT_WORKDAYS_MASK,
  type ChangelogEvent,
  type StatusIdMap,
  type SubtaskRecord,
  type WorkCalendar,
  type WorklogRecord,
} from '@app/shared';
import type { FixtureCalendar, FixtureSubtask } from './fixture-types.js';

/**
 * Đổi dữ liệu fixture (dễ đọc) sang kiểu dữ liệu engine (dễ tính).
 *
 * Chỗ này cũng là nơi ÉP đúng ràng buộc mà `SubtaskRecord` yêu cầu: changelog và
 * worklog phải sắp TĂNG DẦN theo thời gian. Fixture viết sai thứ tự thì engine
 * tua ra kết quả sai mà không có gì báo — sắp lại ở đây để lỗi đó không tồn tại.
 */

export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Mốc thời gian trong fixture không đọc được: "${iso}". Cần chuỗi ISO 8601 có múi giờ.`);
  }
  return ms;
}

export function buildCalendar(spec: FixtureCalendar): WorkCalendar {
  return {
    calendarId: 'fixture',
    timezone: spec.timezone,
    workdaysMask: spec.workdaysMask ?? DEFAULT_WORKDAYS_MASK,
    hoursPerDay: spec.hoursPerDay ?? DEFAULT_HOURS_PER_DAY,
    holidays: new Set(spec.holidays ?? []),
    warnings: [],
  };
}

export function buildStatusIdMap(spec: Readonly<Record<string, string>>): StatusIdMap {
  const map = new Map<string, 'new' | 'indeterminate' | 'done'>();
  for (const [id, category] of Object.entries(spec)) {
    if (category !== 'new' && category !== 'indeterminate' && category !== 'done') {
      throw new Error(`statusIds["${id}"] = "${category}" không phải nhóm trạng thái hợp lệ.`);
    }
    map.set(id, category);
  }
  return map;
}

export function buildSubtask(spec: FixtureSubtask): SubtaskRecord {
  const changelog: ChangelogEvent[] = (spec.changelog ?? [])
    .map((c) => ({
      issueKey: spec.key,
      field: c.field,
      fromValue: c.from,
      toValue: c.to,
      createdAtMs: toMs(c.at),
    }))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);

  const worklogs: WorklogRecord[] = (spec.worklogs ?? [])
    .map((w) => ({
      worklogId: w.id,
      issueKey: spec.key,
      timeSpentSeconds: w.seconds,
      startedAtMs: toMs(w.started),
      isDeleted: w.deleted === true,
    }))
    .sort((a, b) => a.startedAtMs - b.startedAtMs);

  return {
    key: spec.key,
    phaseCode: spec.phaseCode,
    originalEstimateSeconds: spec.originalEstimateSeconds,
    createdAtMs: toMs(spec.createdAt),
    removedAtMs: spec.removedAt === undefined || spec.removedAt === null ? null : toMs(spec.removedAt),
    wbsStartDate: spec.wbsStartDate ?? null,
    wbsEndDate: spec.wbsEndDate ?? null,
    changelog,
    worklogs,
  };
}

// ---------------------------------------------------------------------------
// Hàm dựng gọn, dùng cho test theo tính chất (không đi qua JSON)
// ---------------------------------------------------------------------------

export interface MakeSubtaskOptions {
  readonly key?: string;
  readonly phaseCode?: string;
  /** Vectơ khoá nhóm N tầng (test compute-group-rollups / build-tier-snapshot). */
  readonly groupPath?: readonly string[];
  readonly originalEstimateSeconds?: number;
  readonly createdAt?: string;
  readonly removedAt?: string | null;
  readonly wbsStartDate?: string | null;
  readonly wbsEndDate?: string | null;
  readonly changelog?: readonly { field: string; from: string | null; to: string | null; at: string }[];
  readonly worklogs?: readonly { id: string; seconds: number; started: string; deleted?: boolean }[];
}

/** Sub-task tối giản: có đủ trường bắt buộc, mọi thứ khác nhận mặc định. */
export function makeSubtask(options: MakeSubtaskOptions = {}): SubtaskRecord {
  const base = buildSubtask({
    key: options.key ?? 'X-1',
    phaseCode: options.phaseCode ?? 'DESIGN',
    originalEstimateSeconds: options.originalEstimateSeconds ?? 28_800,
    createdAt: options.createdAt ?? '2026-03-02T01:00:00Z',
    ...(options.removedAt === undefined ? {} : { removedAt: options.removedAt }),
    ...(options.wbsStartDate === undefined ? {} : { wbsStartDate: options.wbsStartDate }),
    ...(options.wbsEndDate === undefined ? {} : { wbsEndDate: options.wbsEndDate }),
    ...(options.changelog === undefined ? {} : { changelog: options.changelog }),
    ...(options.worklogs === undefined ? {} : { worklogs: options.worklogs }),
  });
  // `groupPath` không thuộc `FixtureSubtask` (golden JSON không mang tầng) — gắn thêm ở
  // đây để test N tầng dựng được lá có vectơ khoá, mà không đụng kiểu fixture.
  return options.groupPath === undefined ? base : { ...base, groupPath: options.groupPath };
}

/** Chuyển trạng thái: `status` từ id này sang id kia. */
export function statusChange(from: string, to: string, at: string) {
  return { field: 'status', from, to, at };
}

/** Sửa ước lượng còn lại (`timeestimate`). Giá trị là chuỗi giây, hoặc `null`. */
export function estimateChange(from: string | null, to: string | null, at: string) {
  return { field: 'timeestimate', from, to, at };
}

/** Sửa ước lượng ban đầu (`timeoriginalestimate`). */
export function originalEstimateChange(from: string | null, to: string | null, at: string) {
  return { field: 'timeoriginalestimate', from, to, at };
}

export function makeWorklog(id: string, seconds: number, started: string, deleted = false) {
  return { id, seconds, started, deleted };
}
