import { localDateOf } from '@app/engine';
import { parseSyncJobPayload, type DateOnly, type WorkCalendar } from '@app/shared';
import { resolveRebuildRange, type RebuildRange } from './rebuild-range.js';
import type { ReconstructOutcome } from './reconstruct-epic.job.js';

/**
 * Bộ xử lý job `sync-epic` — chỗ nối `POST /api/epic/:key/resync` với việc dựng
 * lại lịch sử.
 *
 * Trước khi có file này, hai nửa của luồng đồng bộ không hề gặp nhau: API đẩy
 * job kèm `full`, còn worker chỉ đọc mỗi `epicKey` rồi chạy giai đoạn 1–3. Lệnh
 * `{"full":true}` trong runbook chạy trót lọt và không dựng lại gì cả.
 *
 * File này CHỈ điều phối. Quyết định dải ngày nằm ở `resolveRebuildRange` (hàm
 * thuần), còn tính toán nằm ở `reconstructEpic`.
 */

export interface SyncJobPorts {
  /**
   * Giai đoạn 1–3: đọc dữ liệu từ Jira và ghi xuống.
   *
   * `ignoreWatermark = true` thì bỏ qua mốc đồng bộ lần trước và đọc lại toàn bộ.
   */
  syncFromJira(epicKey: string, options: { ignoreWatermark: boolean }): Promise<void>;

  /**
   * Ngày sớm nhất Epic này có dữ liệu — ngày snapshot đầu tiên, hoặc ngày bắt
   * đầu kế hoạch sớm nhất nếu chưa có snapshot nào. `null` = chưa có gì.
   */
  earliestDataDate(epicKey: string): Promise<DateOnly | null>;

  /** Ngày thiếu snapshot sớm nhất (E-12). `null` = không thiếu ngày nào. */
  earliestMissingSnapshotDate(epicKey: string): Promise<DateOnly | null>;

  /** Giai đoạn 4–5: tổng hợp ngày Phase rồi dựng snapshot cho cả dải. */
  rebuild(args: { epicKey: string; from: DateOnly; to: DateOnly }): Promise<ReconstructOutcome>;
}

export interface SyncJobDeps {
  readonly ports: SyncJobPorts;
  readonly calendar: WorkCalendar;
  readonly now: () => Date;
  readonly log?: (event: Record<string, unknown>) => void;
}

export interface SyncJobResult {
  readonly epicKey: string;
  readonly range: RebuildRange;
  readonly outcome: ReconstructOutcome;
}

export async function handleSyncJob(deps: SyncJobDeps, rawPayload: unknown): Promise<SyncJobResult> {
  const payload = parseSyncJobPayload(rawPayload);
  const { epicKey } = payload;

  // Đọc Jira TRƯỚC khi chốt dải ngày. Lượt đọc toàn bộ có thể kéo về Sub-task cũ
  // hơn mọi thứ đang có trong kho, và dải ngày phải phủ được chúng — chốt trước
  // thì dải bị tính theo dữ liệu cũ và phần lịch sử vừa lấy về sẽ nằm ngoài.
  await deps.ports.syncFromJira(epicKey, { ignoreWatermark: payload.full });

  const [earliestDataDate, earliestMissingSnapshotDate] = await Promise.all([
    deps.ports.earliestDataDate(epicKey),
    deps.ports.earliestMissingSnapshotDate(epicKey),
  ]);

  const range = resolveRebuildRange({
    full: payload.full,
    from: payload.from,
    to: payload.to,
    earliestDataDate,
    earliestMissingSnapshotDate,
    today: localDateOf(deps.now().getTime(), deps.calendar.timezone),
    timezone: deps.calendar.timezone,
  });

  // Ghi dải ngày ra log LUÔN, kể cả lượt bình thường. Đây là câu trả lời cho câu
  // hỏi hay gặp nhất khi số liệu trông sai: "lần chạy vừa rồi nó dựng lại từ ngày
  // nào tới ngày nào?"
  deps.log?.({
    event: 'rebuild.range',
    epicKey,
    scope: range.scope,
    from: range.from,
    to: range.to,
    notes: range.notes,
  });

  const outcome = await deps.ports.rebuild({ epicKey, from: range.from, to: range.to });
  return { epicKey, range, outcome };
}
