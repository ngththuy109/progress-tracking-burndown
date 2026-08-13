import type {
  DailySnapshotData,
  DateOnly,
  PhaseRollup,
  PlanShiftRecord,
  StatusIdMap,
  SubtaskActualDates,
  SubtaskRecord,
  WorkCalendar,
} from '@app/shared';
import {
  buildSnapshotForDay,
  computePhaseRollups,
  detectPlanShift,
  listCalendarDays,
  resolveCloseLagWorkdays,
  resolveSubtaskActualDates,
} from '@app/engine';
import {
  acquireLock,
  LockHeartbeat,
  lockKeyFor,
  releaseLock,
  type LockRedis,
} from '../lock/redis-lock.js';

/**
 * Dựng lại lịch sử một Epic — PRD §4.4 Hàm 7.
 *
 * GIAI ĐOẠN 4 (tổng hợp ngày Phase) PHẢI chạy TRƯỚC giai đoạn 5 (dựng snapshot).
 * Làm ngược lại thì snapshot dùng ngày Phase cũ và đường Kế hoạch lệch đúng một
 * lượt đồng bộ — lỗi im lặng, chỉ lộ ra khi so hai lần chạy liên tiếp.
 */

/** Ngày thực tế của một Sub-task, kèm khoá để ghi xuống bảng chi tiết. */
export interface SubtaskActualRecord extends SubtaskActualDates {
  readonly issueKey: string;
  /** Số ngày làm việc đóng trễ so với worklog cuối (B1). `null` = không đo được. */
  readonly closeLagWorkdays: number | null;
}

export interface ReconstructPorts {
  /** Toàn bộ Sub-task kèm lịch sử. Hàm tự lọc theo mốc thời gian từng ngày. */
  loadSubtasks(epicKey: string): Promise<readonly SubtaskRecord[]>;
  loadPreviousRollups(epicKey: string): Promise<ReadonlyMap<string, PhaseRollup>>;
  savePhaseRollups(epicKey: string, rollups: readonly PhaseRollup[]): Promise<void>;
  /** Xoá bản rollup của Phase không còn Sub-task nào (E-24). */
  deleteObsoleteRollups(epicKey: string, livePhaseCodes: readonly string[]): Promise<number>;
  /** Ghi ngày thực tế CHI TIẾT theo từng Sub-task cho Signboard (PRD §2.7.2). */
  saveSubtaskActualDates(rows: readonly SubtaskActualRecord[]): Promise<void>;
  savePlanShifts(epicKey: string, shifts: readonly PlanShiftRecord[]): Promise<{ skippedNullBoundary: number }>;
  /** Ngày đã có snapshot — để dò ngày thiếu (E-12). */
  existingSnapshotDates(epicKey: string): Promise<ReadonlySet<string>>;
  previousTotalScope(epicKey: string, date: DateOnly): Promise<number | undefined>;
  saveSnapshots(rows: readonly DailySnapshotData[]): Promise<{ written: number; skippedStale: number }>;
  /** Xoá cache biểu đồ bằng SCAN, KHÔNG dùng KEYS. */
  invalidateChartCache(epicKey: string): Promise<void>;
  /** Đánh dấu Epic cần tính lại ở lượt sau. */
  markDirty(epicKey: string): Promise<void>;
}

export interface ReconstructDeps {
  readonly ports: ReconstructPorts;
  readonly redis: LockRedis;
  readonly calendar: WorkCalendar;
  readonly statusIdMap: StatusIdMap;
  /** Mốc job đọc dữ liệu từ Jira — vào thẳng `source_read_at` (E-19). */
  readonly sourceReadAtMs: number;
  readonly now: () => Date;
  /** Token sở hữu khoá. Tách ra để test kiểm chứng được việc nhả đúng khoá. */
  readonly lockToken: string;
  readonly onWarning?: (code: string, detail: string) => void;
}

export type ReconstructOutcome =
  | { readonly status: 'SKIPPED_LOCKED'; readonly epicKey: string }
  | {
      readonly status: 'DONE';
      readonly epicKey: string;
      readonly daysComputed: number;
      readonly daysBackfilled: number;
      readonly snapshotsWritten: number;
      readonly snapshotsSkippedStale: number;
      readonly planShifts: number;
      readonly obsoleteRollupsRemoved: number;
    };

export async function reconstructEpic(
  deps: ReconstructDeps,
  args: { epicKey: string; from: DateOnly; to: DateOnly },
): Promise<ReconstructOutcome> {
  const { epicKey } = args;
  const key = lockKeyFor(epicKey);

  const lock = await acquireLock(deps.redis, key, deps.lockToken);
  if (lock === null) {
    // KHÔNG bỏ qua im lặng. Job đêm bỏ qua thì vô hại (mai chạy lại), nhưng bỏ
    // qua một yêu cầu tính lại do log giờ lùi ngày là MẤT VĨNH VIỄN — snapshot
    // quá khứ sai mãi mãi.
    await deps.ports.markDirty(epicKey);
    return { status: 'SKIPPED_LOCKED', epicKey };
  }

  let lockLost = false;
  const heartbeat = new LockHeartbeat(deps.redis, lock, undefined, undefined, () => {
    lockLost = true;
  });
  heartbeat.start();

  try {
    const subtasks = await deps.ports.loadSubtasks(epicKey);

    // --- GIAI ĐOẠN 4: tổng hợp ngày Phase, TRƯỚC khi dựng snapshot ---
    const previousRollups = await deps.ports.loadPreviousRollups(epicKey);
    const rollups = computePhaseRollups({
      subtasks,
      calendar: deps.calendar,
      statusIdMap: deps.statusIdMap,
      asOfMs: deps.now().getTime(),
    });

    for (const r of rollups) {
      for (const w of r.warnings) deps.onWarning?.(w.code, w.message);
    }

    const shifts: PlanShiftRecord[] = [];
    for (const r of rollups) {
      shifts.push(
        ...detectPlanShift(previousRollups.get(r.phaseCode) ?? null, r, subtasks, deps.calendar),
      );
    }

    await deps.ports.savePhaseRollups(epicKey, rollups);
    const obsoleteRollupsRemoved = await deps.ports.deleteObsoleteRollups(
      epicKey,
      rollups.map((r) => r.phaseCode),
    );

    // Ngày thực tế CHI TIẾT theo ticket cho Signboard. Engine đã tính đúng giá
    // trị này ở trên để tổng hợp rollup (MIN/MAX) rồi bỏ đi — ở đây giữ lại bản
    // per Sub-task. Cùng nguồn sự thật nên bảng chi tiết và bản tổng hợp luôn khớp.
    await deps.ports.saveSubtaskActualDates(
      subtasks.map((s) => ({
        issueKey: s.key,
        ...resolveSubtaskActualDates(s, deps.statusIdMap, deps.calendar.timezone),
        closeLagWorkdays: resolveCloseLagWorkdays(s, deps.statusIdMap, deps.calendar),
      })),
    );
    if (shifts.length > 0) {
      const { skippedNullBoundary } = await deps.ports.savePlanShifts(epicKey, shifts);
      if (skippedNullBoundary > 0) {
        deps.onWarning?.(
          'PLAN_SHIFT_NULL_BOUNDARY',
          `${epicKey}: bỏ qua ${skippedNullBoundary} bản ghi dịch chuyển có mốc rỗng ` +
            `(kế hoạch vừa xuất hiện, chưa phải dịch chuyển).`,
        );
      }
    }

    // --- GIAI ĐOẠN 5: dựng snapshot từng ngày lịch ---
    //
    // MỌI ngày lịch, KHÔNG chỉ ngày làm việc (quyết định 2026-08): team log giờ
    // vào Thứ 7/CN thì snapshot của đúng ngày đó phải mang số thật, để đường
    // Thực tế giảm ngay hôm làm thay vì dồn cả vào sáng Thứ 2. Ngày nghỉ không
    // ai làm gì thì snapshot phẳng so với hôm trước — biểu đồ bôi xám ngày nghỉ
    // nên đoạn phẳng đọc đúng nghĩa "nghỉ". Đường Kế hoạch của ngày nghỉ cũng
    // phẳng sẵn vì công thức T-16 chỉ đốt theo ngày làm việc.
    const days = listCalendarDays(args.from, args.to, deps.calendar.timezone);

    // Dò ngày thiếu (E-12): job hôm sau tự bù những ngày job trước bỏ lỡ. Không
    // bù thì biểu đồ thủng lỗ và đường nối tắt qua ngày trống gây hiểu nhầm.
    const existing = await deps.ports.existingSnapshotDates(epicKey);
    const daysBackfilled = days.filter((d) => !existing.has(d)).length;

    const snapshots: DailySnapshotData[] = [];
    let previousScope = await deps.ports.previousTotalScope(epicKey, args.from);

    for (const dateStr of days) {
      const snap = buildSnapshotForDay({
        epicKey,
        subtasks,
        phaseRollups: rollups,
        dateStr,
        calendar: deps.calendar,
        statusIdMap: deps.statusIdMap,
        sourceReadAtMs: deps.sourceReadAtMs,
        previousTotalScopeS: previousScope,
        onWarning: deps.onWarning,
      });
      snapshots.push(snap);
      // Ngày sau so với ngày vừa dựng, không phải với snapshot cũ trong DB.
      previousScope = snap.totalScopeS;
    }

    // Mất khoá giữa chừng nghĩa là job khác đã chiếm và có thể đang ghi. Ghi đè
    // lên họ sẽ tạo ra dữ liệu trộn lẫn từ hai lượt đọc Jira khác nhau.
    if (lockLost) {
      deps.onWarning?.(
        'LOCK_LOST',
        `${epicKey}: mất khoá giữa chừng, bỏ qua việc ghi và đánh dấu tính lại.`,
      );
      await deps.ports.markDirty(epicKey);
      return { status: 'SKIPPED_LOCKED', epicKey };
    }

    const { written, skippedStale } = await deps.ports.saveSnapshots(snapshots);

    // Xoá cache SAU KHI ghi xong. Xoá trước thì request xen vào giữa sẽ nạp lại
    // đúng dữ liệu cũ và cache nó thêm 15 phút nữa.
    await deps.ports.invalidateChartCache(epicKey);

    return {
      status: 'DONE',
      epicKey,
      daysComputed: snapshots.length,
      daysBackfilled,
      snapshotsWritten: written,
      snapshotsSkippedStale: skippedStale,
      planShifts: shifts.length,
      obsoleteRollupsRemoved,
    };
  } finally {
    // Tắt heartbeat TRƯỚC khi nhả khoá, và luôn ở trong `finally` — job lỗi
    // giữa chừng cũng phải nhả khoá, nếu không Epic bị bỏ qua tới hết TTL.
    //
    // Quên `stop()` là rò rỉ: worker chạy vài ngày sẽ tích tụ hàng trăm bộ đếm
    // giờ đang gia hạn những khoá không còn tồn tại.
    heartbeat.stop();
    await releaseLock(deps.redis, lock);
  }
}
