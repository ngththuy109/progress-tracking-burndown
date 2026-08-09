import { Navigate, Route, Routes } from 'react-router-dom';
import { EmptyState } from '../components/ui/index.js';
import { AppLayout } from '../layout/app-layout.js';
import { DEFAULT_PATH } from '../layout/nav-items.js';
import { ConfigPhaseScreen } from './config-phase/index.js';
import { EpicListScreen } from './epics/index.js';
import { BurndownScreen } from './burndown/index.js';
import { SignboardScreen } from './signboard/index.js';
import { SignboardColumnScreen } from './config-signboard/index.js';
import { OpsScreen } from './ops/index.js';
import { AdminUsersScreen } from './admin-users/index.js';

/**
 * Bảng định tuyến.
 *
 * Viết thẳng từng `<Route>` chứ không sinh tự động từ `NAV_ITEMS`: T-21 và các
 * card GĐ 4 chỉ cần đổi đúng một dòng ở đây, và đọc file này là biết ngay màn
 * hình nào đã có thật.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<Navigate to={DEFAULT_PATH} replace />} />

        <Route path="epics" element={<EpicListScreen />} />
        <Route path="burndown" element={<BurndownScreen />} />
        <Route path="signboard" element={<SignboardScreen />} />
        <Route path="config/phase" element={<ConfigPhaseScreen />} />
        <Route path="config/signboard" element={<SignboardColumnScreen />} />
        <Route path="ops" element={<OpsScreen />} />
        <Route path="admin/users" element={<AdminUsersScreen />} />

        <Route
          path="*"
          element={
            <EmptyState
              icon="🔍"
              title="Page not found"
              description="That address does not exist. Pick a screen from the sidebar to continue."
            />
          }
        />
      </Route>
    </Routes>
  );
}
