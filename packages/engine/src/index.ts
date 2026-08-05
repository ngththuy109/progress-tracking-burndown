/**
 * @app/engine — TOÀN BỘ logic nghiệp vụ, thuần tính toán.
 *
 * HAI RÀNG BUỘC BẮT BUỘC (ARCHITECTURE.md §2), có lint rule chặn:
 *
 * 1. KHÔNG được import `@app/db` hoặc `@app/jira`.
 *    Engine chứa logic được kiểm chứng bằng 20 golden dataset. Nếu nó import db
 *    hay jira thì muốn chạy test phải dựng PostgreSQL và Jira sandbox — bộ test
 *    từ vài giây thành vài phút, và sẽ không ai chạy nó nữa.
 *
 * 2. KHÔNG được đọc đồng hồ (`new Date()`, `Date.now()`).
 *    Hàm cần "hôm nay" phải nhận qua tham số `asOfDate`. Trạng thái Signboard
 *    phụ thuộc hôm nay là ngày nào (PRD §6.3); test không đóng băng đồng hồ sẽ
 *    xanh hôm nay và đỏ tuần sau.
 *
 * Đầu vào là dữ liệu đã nạp sẵn trong RAM, đầu ra là dữ liệu. Không đọc file,
 * không gọi mạng, không đọc đồng hồ.
 */

export const ENGINE_PACKAGE_VERSION = '0.1.0' as const;

export * from './status/index.js';
export * from './config/merge-inheritance.js';
export * from './parser/index.js';
export * from './calendar/index.js';

export * from './remaining/index.js';
export * from './rollup/index.js';
export * from './signboard/index.js';
export * from './planned/index.js';
export * from './snapshot/index.js';
export * from './reconcile/compare-totals.js';
export * from './alerts/evaluate-thresholds.js';
