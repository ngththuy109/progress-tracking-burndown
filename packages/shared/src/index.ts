/**
 * @app/shared — type và zod schema dùng chung giữa frontend và backend.
 *
 * Quy ước (ARCHITECTURE.md §3): mỗi task card tạo MỘT file riêng trong thư mục
 * này rồi thêm đúng một dòng export vào đây. Không gom mọi type vào một file —
 * `packages/shared` là điểm nghẽn xung đột khi nhiều agent chạy song song.
 *
 * Package này không được phụ thuộc vào bất kỳ package nào khác.
 */

/** Phiên bản khung dự án. */
export const SHARED_PACKAGE_VERSION = '0.1.0' as const;

export * from './enums.js';
export * from './issue-history.js';
export * from './phase-config.js';
export * from './issue-path.js';
export * from './subtask-parse.js';
export * from './api-config.js';
export * from './tracked-epic.js';
export * from './calendar.js';
export * from './actual-dates.js';
export * from './signboard.js';
export * from './phase-rollup.js';
export * from './snapshot.js';
export * from './api-burndown.js';
export * from './api-epic-ops.js';
export * from './sync-job.js';
export * from './reconcile.js';
export * from './alerts.js';
export * from './metrics.js';
export * from './api-signboard.js';
export * from './api-ops.js';
export * from './with-timeout.js';
