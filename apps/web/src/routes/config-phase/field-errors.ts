import type { ApiErrorIssue } from '../../api/client.js';
import { ApiError } from '../../api/client.js';

/**
 * Neo lỗi kiểm tra hợp lệ vào ĐÚNG trường gây lỗi.
 *
 * Hiện tất cả thành một banner ở đầu trang thì PM không biết sửa dòng nào —
 * nhất là khi có 20 luật khớp và thông báo chỉ nói "cấu hình không hợp lệ".
 *
 * `path` do máy chủ trả về có dạng `matchRules[0].phaseCode`,
 * `phaseDefinitions[2].phaseCode`, hoặc trần trụi `phaseDefinitions`.
 */

export interface FieldErrorIndex {
  /** Lỗi neo đúng vào đường dẫn này. */
  at(path: string): readonly ApiErrorIssue[];
  /** Lỗi neo vào bất kỳ trường nào của phần tử thứ `index` trong `field`. */
  atRow(field: string, index: number): readonly ApiErrorIssue[];
  /** Lỗi KHÔNG có `path` — không neo được vào đâu nên phải hiện ở đầu trang. */
  readonly unanchored: readonly ApiErrorIssue[];
  readonly all: readonly ApiErrorIssue[];
  readonly hasBlocking: boolean;
}

export function indexIssues(issues: readonly ApiErrorIssue[]): FieldErrorIndex {
  const byPath = new Map<string, ApiErrorIssue[]>();
  const unanchored: ApiErrorIssue[] = [];

  for (const issue of issues) {
    if (issue.path === null || issue.path === '') {
      unanchored.push(issue);
      continue;
    }
    const bucket = byPath.get(issue.path);
    if (bucket === undefined) byPath.set(issue.path, [issue]);
    else bucket.push(issue);
  }

  return {
    at: (path) => byPath.get(path) ?? [],
    atRow: (field, index) => {
      const prefix = `${field}[${index}]`;
      const out: ApiErrorIssue[] = [];
      for (const [path, list] of byPath) {
        if (path === prefix || path.startsWith(`${prefix}.`)) out.push(...list);
      }
      return out;
    },
    unanchored,
    all: issues,
    hasBlocking: issues.some((i) => i.level === 'ERROR'),
  };
}

export const NO_ISSUES: FieldErrorIndex = indexIssues([]);

/**
 * Bóc danh sách lỗi ra khỏi một lỗi bất kỳ.
 *
 * Lỗi mạng hay lỗi máy chủ không có `issues` — trả về danh sách rỗng để màn
 * hình rơi về `ErrorState` chung, thay vì im lặng không hiện gì.
 */
export function issuesOf(error: unknown): readonly ApiErrorIssue[] {
  return error instanceof ApiError ? error.issues : [];
}
