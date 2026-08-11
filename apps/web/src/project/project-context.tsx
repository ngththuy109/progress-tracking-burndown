import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, useParams } from 'react-router-dom';
import type { ProjectRole } from '@app/shared';
import { useMe } from '../api/use-me.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/index.js';

/**
 * Ngữ cảnh DỰ ÁN ĐANG MỞ — nguồn duy nhất của `projectKey` cho mọi hook API.
 *
 * Mọi trang nghiệp vụ nằm dưới `/p/:projectKey/...`. `ProjectProvider` đọc key
 * từ URL, đối chiếu với `/api/me` (danh sách dự án user truy cập được) rồi mới
 * cho render. Key lạ hay không có quyền → đá về trang chọn dự án, KHÔNG render
 * một màn hình chắc chắn chỉ toàn lỗi 403.
 */

export interface ProjectScope {
  readonly projectKey: string;
  /** Role hiệu dụng trong dự án này. ADMIN toàn cục nhận 'PM'. */
  readonly role: ProjectRole;
  /** ADMIN toàn cục — thấy thêm khu quản trị. */
  readonly isAdmin: boolean;
}

/** Khoá localStorage ghi dự án mở lần gần nhất — trang `/` đọc để chuyển thẳng. */
export const LAST_PROJECT_STORAGE_KEY = 'ptb.lastProject';

/** Đọc dự án dùng lần trước. localStorage bị chặn (Safari private…) thì thôi. */
export function readLastProject(): string | null {
  try {
    return globalThis.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeLastProject(projectKey: string): void {
  try {
    globalThis.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectKey);
  } catch {
    // Không ghi được thì lần sau người dùng tự chọn lại — không đáng báo lỗi.
  }
}

export function clearLastProject(): void {
  try {
    globalThis.localStorage.removeItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    // Như trên.
  }
}

/** Đường dẫn tuyệt đối tới một trang trong dự án, ví dụ `projectPath('PAY', 'epics')`. */
export function projectPath(projectKey: string, sub = ''): string {
  return `/p/${encodeURIComponent(projectKey)}${sub === '' ? '' : `/${sub}`}`;
}

const ProjectScopeContext = createContext<ProjectScope | null>(null);

/**
 * Bọc một giá trị scope CỐ ĐỊNH quanh cây con — dùng cho test và cho
 * `ProjectProvider` bên dưới. Test không cần dựng router `/p/:projectKey`.
 */
export function ProjectScopeProvider({
  value,
  children,
}: {
  readonly value: ProjectScope;
  readonly children: ReactNode;
}) {
  return <ProjectScopeContext.Provider value={value}>{children}</ProjectScopeContext.Provider>;
}

/** Scope của dự án đang mở. Gọi ngoài `/p/:projectKey/...` là lỗi lập trình. */
export function useProject(): ProjectScope {
  const scope = useContext(ProjectScopeContext);
  if (scope === null) {
    throw new Error(
      'useProject() phải được gọi bên trong <ProjectProvider> (route /p/:projectKey/...).',
    );
  }
  return scope;
}

/** Chỉ lấy key — dạng gọn cho các hook API. */
export function useProjectKey(): string {
  return useProject().projectKey;
}

/**
 * Route element cho nhánh `/p/:projectKey`: kiểm quyền rồi render `<Outlet />`
 * trong ngữ cảnh dự án.
 */
export function ProjectProvider() {
  const params = useParams();
  const projectKey = params['projectKey'] ?? '';
  const me = useMe();

  const membership = me.data?.projects.find((p) => p.projectKey === projectKey);

  // Ghi "dự án dùng gần nhất" NGOÀI render — đây là side effect.
  useEffect(() => {
    if (membership !== undefined) writeLastProject(projectKey);
  }, [membership, projectKey]);

  if (me.isPending) return <LoadingState label="Đang kiểm tra quyền truy cập dự án…" rows={2} />;
  if (me.isError) {
    return (
      <ErrorState
        error={me.error}
        title="Không kiểm tra được quyền truy cập"
        onRetry={() => void me.refetch()}
      />
    );
  }
  if (me.data === null || me.data === undefined) {
    // 401 — cổng SSO lo việc đăng nhập; ở đây chỉ nói rõ trạng thái.
    return (
      <EmptyState
        icon="🔒"
        title="Chưa đăng nhập"
        description="Phiên đăng nhập đã hết hạn. Tải lại trang để đăng nhập lại."
      />
    );
  }

  if (membership === undefined) {
    // Key lạ hoặc không có quyền: dọn localStorage nếu nó đang trỏ đúng key
    // hỏng này, rồi về trang chọn dự án — tránh vòng lặp chuyển hướng.
    if (readLastProject() === projectKey) clearLastProject();
    return <Navigate to="/" replace />;
  }

  return (
    <ProjectScopeProvider
      value={{ projectKey, role: membership.role, isAdmin: me.data.isAdmin }}
    >
      <Outlet />
    </ProjectScopeProvider>
  );
}
