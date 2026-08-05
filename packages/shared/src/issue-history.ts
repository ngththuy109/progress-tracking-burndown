import type { StatusCategory } from './enums.js';

/**
 * Kiểu dữ liệu lịch sử issue — dùng chung giữa engine, db và worker.
 *
 * Engine nhận dữ liệu này qua THAM SỐ, không tự đọc database (ARCHITECTURE.md §2).
 */

/** Một sự kiện trong changelog của Jira. */
export interface ChangelogEvent {
  readonly issueKey: string;
  /** status | timeestimate | timeoriginalestimate | parent | summary */
  readonly field: string;
  readonly fromValue: string | null;
  readonly toValue: string | null;
  /** Mốc UTC, đơn vị mili-giây. */
  readonly createdAtMs: number;
}

/** Một bản ghi log giờ. */
export interface WorklogRecord {
  readonly worklogId: string;
  readonly issueKey: string;
  readonly timeSpentSeconds: number;
  /**
   * LẤY TỪ TRƯỜNG `started` CỦA JIRA, KHÔNG phải `created`.
   *
   * Đây là ngày người dùng khai đã làm. Nhờ vậy log giờ lùi ngày tự động được
   * tính vào đúng ngày (PRD E-03).
   */
  readonly startedAtMs: number;
  readonly isDeleted: boolean;
}

/** Một Sub-task kèm đủ lịch sử để dựng lại trạng thái quá khứ. */
export interface SubtaskRecord {
  readonly key: string;
  /** Phase LẤY TỪ TASK CHA, không lấy từ tiêu đề Sub-task (PRD §2.9.2). */
  readonly phaseCode: string;
  readonly originalEstimateSeconds: number;
  readonly createdAtMs: number;
  /** null = còn trong Epic. */
  readonly removedAtMs: number | null;

  /** Ngày kế hoạch, đọc từ custom field `wbs_*`. null = chưa điền. */
  readonly wbsStartDate: string | null;
  readonly wbsEndDate: string | null;

  /** Đã sắp xếp TĂNG DẦN theo `createdAtMs`. Sai thứ tự thì tua ra kết quả sai. */
  readonly changelog: readonly ChangelogEvent[];
  /** Đã sắp xếp TĂNG DẦN theo `startedAtMs`. */
  readonly worklogs: readonly WorklogRecord[];
}

/** Bảng tra `status_id` (dạng số, lấy từ changelog) sang nhóm trạng thái. */
export type StatusIdMap = ReadonlyMap<string, StatusCategory>;
