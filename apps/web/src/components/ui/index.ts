/**
 * Bộ component dùng chung.
 *
 * KHÔNG component nào ở đây được gọi API. Chúng nhận dữ liệu qua props để dùng
 * lại được ở mọi màn hình và test được mà không cần dựng máy chủ.
 */
export { Badge, BADGE_TONES, type BadgeProps, type BadgeTone } from './badge.js';
export {
  compareSortValues,
  DataTable,
  type Column,
  type DataTableProps,
  type SortDirection,
  type SortValue,
} from './data-table.js';
export { EmptyState, type EmptyStateProps } from './empty-state.js';
export { ErrorBoundary } from './error-boundary.js';
export { describeError, ErrorState, type ErrorDescription, type ErrorStateProps } from './error-state.js';
export { LoadingState, type LoadingStateProps } from './loading-state.js';
