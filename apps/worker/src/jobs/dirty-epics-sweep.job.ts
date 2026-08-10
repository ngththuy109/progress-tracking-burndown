/**
 * Quét set `dirty:epics` — mắt xích còn thiếu của PRD §2.2.7 (T-18/T-23).
 *
 * Ai GHI vào set này:
 *   - API khi Lưu / rollback Phase settings (`phase-config.service.ts`) — cần
 *     phân loại lại `phase_code` theo cấu hình mới;
 *   - pipeline đồng bộ khi phát hiện worklog log lùi ngày (E-03);
 *   - job dựng lại khi không lấy được khoá hoặc mất khoá giữa chừng (E-19).
 *
 * Job này nhặt TOÀN BỘ Epic trong set rồi đẩy mỗi Epic một job chạy bù toàn bộ
 * (`{"full":true}`). Phải là BACKFILL chứ không phải chỉ dựng lại snapshot:
 * `phase_code` nằm trên dữ liệu thô `jira_issue` và chỉ được gán lúc đọc Jira về
 * (giai đoạn 3) — dựng lại từ dữ liệu thô cũ thì tính bao nhiêu lần cũng ra sai
 * y hệt. Backfill đắt hơn mức cần cho ca log lùi ngày, nhưng đúng cho MỌI lý do
 * bị đánh dấu — một hành vi duy nhất, không phải đoán "vì sao Epic này dirty".
 *
 * HÀM THUẦN ĐIỀU PHỐI: mọi thứ bên ngoài (Redis, sổ theo dõi, hàng đợi) đi qua
 * cổng, nên test được không cần hạ tầng.
 */

export interface DirtySweepPorts {
  /**
   * Lấy toàn bộ Epic khỏi set VÀ XOÁ chúng khỏi set (SPOP) trong một thao tác.
   *
   * Không dùng SMEMBERS + SREM tách rời: giữa hai lệnh đó một tiến trình khác
   * có thể SADD thêm Epic mới, và SREM cả set sẽ xoá nhầm yêu cầu chưa kịp đọc.
   */
  takeAll(): Promise<readonly string[]>;
  /** Trả Epic về set khi đẩy job thất bại — yêu cầu tính lại KHÔNG được phép mất. */
  restore(epicKeys: readonly string[]): Promise<void>;
  /** Trong các key đưa vào, key nào còn trong sổ theo dõi (`tracked_epic`). */
  trackedOf(epicKeys: readonly string[]): Promise<ReadonlySet<string>>;
  /** Đẩy job chạy bù toàn bộ cho một Epic. */
  enqueueFullBackfill(epicKey: string): Promise<void>;
}

export interface DirtySweepDeps {
  readonly ports: DirtySweepPorts;
  readonly log?: (event: Record<string, unknown>) => void;
}

export interface DirtySweepOutcome {
  readonly taken: number;
  readonly queued: number;
  /** Không còn trong sổ theo dõi — bỏ, KHÔNG trả về set (trả về sẽ lặp vô hạn). */
  readonly dropped: readonly string[];
  /** Đẩy job thất bại — đã trả về set để lượt sau thử lại. */
  readonly restored: readonly string[];
}

export async function sweepDirtyEpics(deps: DirtySweepDeps): Promise<DirtySweepOutcome> {
  const { ports, log } = deps;

  const taken = await ports.takeAll();
  if (taken.length === 0) {
    return { taken: 0, queued: 0, dropped: [], restored: [] };
  }

  const queued = new Set<string>();
  const dropped: string[] = [];
  const restored: string[] = [];

  try {
    const tracked = await ports.trackedOf(taken);

    for (const epicKey of taken) {
      if (!tracked.has(epicKey)) {
        // Epic đã bị gỡ khỏi sổ sau khi bị đánh dấu. Đẩy job cho nó chỉ tạo một
        // job hỏng lặp lại mãi; ghi log rồi bỏ là kết cục đúng.
        dropped.push(epicKey);
        continue;
      }
      try {
        await ports.enqueueFullBackfill(epicKey);
        queued.add(epicKey);
      } catch (err) {
        // MỘT Epic hỏng không được làm mất yêu cầu của các Epic còn lại.
        restored.push(epicKey);
        log?.({
          event: 'dirty-sweep.enqueue-failed',
          correlationId: epicKey,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (restored.length > 0) await ports.restore(restored);
  } catch (err) {
    // Lỗi ngoài dự kiến (đọc sổ theo dõi, trả về set…): các key đã SPOP ra mà
    // chưa vào được hàng đợi sẽ mất vĩnh viễn nếu không trả lại — snapshot quá
    // khứ sai mà không ai biết (T-18). Trả lại hết phần chưa đẩy rồi ném tiếp
    // để BullMQ đánh dấu job hỏng.
    const pending = taken.filter((k) => !queued.has(k));
    if (pending.length > 0) await ports.restore(pending);
    throw err;
  }

  log?.({
    event: 'dirty-sweep.done',
    taken: taken.length,
    queued: queued.size,
    dropped: dropped.length,
    restored: restored.length,
  });

  return { taken: taken.length, queued: queued.size, dropped, restored };
}
