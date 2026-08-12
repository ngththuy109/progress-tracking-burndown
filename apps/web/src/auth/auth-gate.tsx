import type { ReactNode } from 'react';
import { useAuthMode } from '../api/use-auth-mode.js';
import { useMe } from '../api/use-me.js';
import { LoginScreen } from './login-screen.js';

/**
 * Cửa vào của toàn app khi chạy chế độ LDAP.
 *
 * CHƯA ĐĂNG NHẬP (`/api/me` trả 401 → `useMe` cho `null`) VÀ mode = LDAP thì
 * thay cả app bằng form đăng nhập. Mọi trường hợp khác — mode HEADER, mode
 * chưa tải xong, hay chính `/api/auth/mode` hỏng — đều GIỮ NGUYÊN hành vi cũ:
 * app render bình thường, cổng/proxy (nếu có) tự lo phần đăng nhập. Nhờ vậy
 * bật tính năng này không đổi gì ở các môi trường HEADER hiện hữu.
 *
 * HẾT HẠN GIỮA PHIÊN cũng đổ về đây: `query-client.ts` bắt 401 của MỌI
 * query/mutation và đặt cache `me` về `null` khi mode = LDAP — component này
 * chỉ việc render theo cache, không cần thêm đường ống riêng.
 */
export function AuthGate({ children }: { readonly children: ReactNode }) {
  const mode = useAuthMode();
  const me = useMe();

  if (mode.data?.mode === 'LDAP' && !me.isPending && me.data === null) {
    return <LoginScreen />;
  }
  return <>{children}</>;
}
