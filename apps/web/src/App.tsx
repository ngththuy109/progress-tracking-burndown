import { QueryClientProvider } from '@tanstack/react-query';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { createQueryClient } from './api/query-client.js';
import { AuthGate } from './auth/auth-gate.js';
import { ErrorBoundary } from './components/ui/index.js';
import { AppRoutes } from './routes/app-routes.js';

/**
 * Gốc của app.
 *
 * Thứ tự bọc có chủ ý:
 *   QueryClientProvider → QueryErrorResetBoundary → ErrorBoundary → Router
 *
 * `ErrorBoundary` phải nằm TRONG `QueryErrorResetBoundary` thì nút "Thử lại"
 * mới xoá được trạng thái lỗi của query. Bọc ngược lại thì bấm "Thử lại" chỉ vẽ
 * lại component, TanStack Query trả nguyên lỗi cũ từ cache, và nút bấm trông
 * như hỏng.
 */

/** Tạo một lần, ở ngoài component: dựng lại mỗi lần vẽ là xoá sạch cache. */
const queryClient = createQueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ErrorBoundary onReset={reset}>
            <BrowserRouter>
              {/* Chế độ LDAP + chưa đăng nhập → thay cả app bằng form đăng
                  nhập tên/mật khẩu. Chế độ HEADER giữ nguyên hành vi cũ. */}
              <AuthGate>
                <AppRoutes />
              </AuthGate>
            </BrowserRouter>
          </ErrorBoundary>
        )}
      </QueryErrorResetBoundary>
    </QueryClientProvider>
  );
}
