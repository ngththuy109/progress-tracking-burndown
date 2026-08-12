import { Navigate, Route, Routes } from 'react-router-dom';
import { EmptyState } from '../components/ui/index.js';
import { AppLayout } from '../layout/app-layout.js';
import { DEFAULT_PROJECT_SUB } from '../layout/nav-items.js';
import { ProjectProvider } from '../project/project-context.js';
import { ProjectPickerScreen } from './project-picker/index.js';
import { ConfigPhaseScreen } from './config-phase/index.js';
import { EpicListScreen } from './epics/index.js';
import { BurndownScreen } from './burndown/index.js';
import { SignboardScreen } from './signboard/index.js';
import { PhaseSubtasksScreen } from './phase-subtasks/index.js';
import { SignboardColumnScreen } from './config-signboard/index.js';
import { HolidaysScreen } from './config-holidays/index.js';
import { OpsScreen } from './ops/index.js';
import { AdminUsersScreen } from './admin-users/index.js';
import { AdminProjectsScreen } from './admin-projects/index.js';
import { AdminLdapScreen } from './admin-ldap/index.js';

/**
 * Bảng định tuyến — bản multi-tenant.
 *
 * Mọi màn hình NGHIỆP VỤ nằm dưới `/p/:projectKey/...`; `ProjectProvider` kiểm
 * quyền theo `/api/me` rồi mới cho render (key lạ / mất quyền → về `/`). Trang
 * `/` tự chuyển tới dự án dùng lần trước, hoặc hiện trang chọn dự án. Khu
 * `/admin/...` không thuộc dự án nào — chỉ ADMIN dùng.
 *
 * Viết thẳng từng `<Route>` chứ không sinh tự động từ `NAV_ITEMS`: các card chỉ
 * cần đổi đúng một dòng ở đây, và đọc file này là biết ngay màn hình nào đã có
 * thật.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<ProjectPickerScreen />} />

        <Route path="p/:projectKey" element={<ProjectProvider />}>
          <Route index element={<Navigate to={DEFAULT_PROJECT_SUB} replace />} />

          <Route path="epics" element={<EpicListScreen />} />
          <Route path="burndown" element={<BurndownScreen />} />
          <Route path="signboard" element={<SignboardScreen />} />
          <Route path="phase-subtasks" element={<PhaseSubtasksScreen />} />
          <Route path="config/phase" element={<ConfigPhaseScreen />} />
          <Route path="config/signboard" element={<SignboardColumnScreen />} />
          <Route path="config/holidays" element={<HolidaysScreen />} />
          <Route path="ops" element={<OpsScreen />} />
        </Route>

        <Route path="admin/projects" element={<AdminProjectsScreen />} />
        <Route path="admin/users" element={<AdminUsersScreen />} />
        <Route path="admin/ldap" element={<AdminLdapScreen />} />

        <Route
          path="*"
          element={
            <EmptyState
              icon="🔍"
              title="Không tìm thấy trang"
              description="Địa chỉ này không tồn tại. Chọn một màn hình ở thanh bên để tiếp tục."
            />
          }
        />
      </Route>
    </Routes>
  );
}
