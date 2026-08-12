import { useState } from 'react';
import {
  HIERARCHY_DEPTH_MAX,
  HIERARCHY_DEPTH_MIN,
  PROJECT_ROLE,
  PROJECT_STATUS,
  type ProjectRole,
  type ProjectStatus,
  type ProjectView,
  type UpdateProjectJiraRequest,
  type UpsertProjectRequest,
} from '@app/shared';
import { useMe } from '../../api/use-me.js';
import { useBuiltinCalendars } from '../../api/use-calendars.js';
import {
  useProjectMembers,
  useProjects,
  useRemoveMember,
  useTestProjectJira,
  useUpdateProjectJira,
  useUpsertMember,
  useUpsertProject,
} from '../../api/use-projects.js';
import { Badge, EmptyState, ErrorState, LoadingState, type BadgeTone } from '../../components/ui/index.js';

/**
 * Màn hình danh mục Project (tenant) — chỉ ADMIN.
 *
 * Mỗi project là MỘT TENANT: có kết nối Jira riêng (token write-only), độ sâu
 * cây ticket riêng, múi giờ/lịch mặc định riêng và danh sách thành viên riêng
 * (PM/VIEWER). Ba mục cài đặt tương ứng ba khu của form bên dưới.
 */

const STATUS_TONE: Record<ProjectStatus, BadgeTone> = {
  ACTIVE: 'success',
  ARCHIVED: 'neutral',
};

const STATUS_LABEL: Record<ProjectStatus, string> = {
  ACTIVE: 'đang hoạt động',
  ARCHIVED: 'đã lưu trữ',
};

/**
 * Xem trước vai trò từng tầng theo `hierarchyDepth` (số tầng DƯỚI root theo
 * dõi). Depth 2 là mô hình Epic/Task/Sub-task cổ điển. Tầng CUỐI luôn là đơn
 * vị tính số liệu (giờ ước tính, ngày kế hoạch); các tầng giữa chỉ để gom nhóm.
 */
export function hierarchyPreview(depth: number): string {
  const tiers = ['Epic (root theo dõi)'];
  for (let i = 1; i < depth; i += 1) tiers.push('Task trung gian');
  tiers.push('Sub-task (đơn vị số liệu)');
  return tiers.join(' → ');
}

export function AdminProjectsScreen() {
  const me = useMe();

  if (me.isPending) return <LoadingState label="Đang tải…" rows={2} />;
  if (me.data && !me.data.isAdmin) {
    return (
      <EmptyState
        icon="🔒"
        title="Chỉ dành cho quản trị viên"
        description="Chỉ ADMIN quản lý được danh mục dự án. Liên hệ quản trị viên nếu bạn cần quyền."
      />
    );
  }
  return <ProjectsManager />;
}

function ProjectsManager() {
  const query = useProjects();
  /** Key của dự án đang mở cài đặt; `'NEW'` = form tạo dự án mới; null = chỉ xem danh sách. */
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (query.isPending) return <LoadingState label="Đang tải danh mục dự án…" rows={3} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Không tải được danh mục dự án"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const projects = query.data;
  const open = projects.find((p) => p.projectKey === openKey) ?? null;

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="projects-title">
        <h2 className="panel__title" id="projects-title">
          Dự án (tenant)
        </h2>
        <p className="panel__hint">
          Mỗi dự án là một tenant với kết nối Jira, cấu hình và thành viên riêng. Mở{' '}
          <strong>Cài đặt</strong> để sửa thông tin chung, kết nối Jira và thành viên.
        </p>

        {projects.length === 0 ? (
          <EmptyState
            title="Chưa có dự án nào"
            description="Bấm “Thêm dự án” để đăng ký tenant đầu tiên."
          />
        ) : (
          <ul className="rows" aria-label="Dự án">
            {projects.map((p) => (
              <li className="row" key={p.projectKey}>
                <code>{p.projectKey}</code>
                {p.displayName !== null && <span>{p.displayName}</span>}
                <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                <span className="muted">độ sâu {p.hierarchyDepth}</span>
                <Badge tone={p.memberCount > 0 ? 'info' : 'neutral'}>
                  {p.memberCount} thành viên
                </Badge>
                {/* Jira: token riêng đã nhập hay đang dùng biến môi trường chung. */}
                <span className="muted">
                  {p.hasJiraToken ? 'Jira: token riêng' : 'Jira: dùng env chung'}
                </span>

                <span className="row__spacer" />

                <button
                  type="button"
                  className="button"
                  onClick={() => setOpenKey(openKey === p.projectKey ? null : p.projectKey)}
                >
                  {openKey === p.projectKey ? 'Đóng cài đặt' : 'Cài đặt'}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="actions">
          <button type="button" className="button" onClick={() => setOpenKey('NEW')}>
            ＋ Thêm dự án
          </button>
        </div>
      </section>

      {openKey === 'NEW' && open === null && (
        <GeneralSection project={null} onSaved={(key) => setOpenKey(key)} />
      )}

      {open !== null && (
        <>
          <GeneralSection
            key={`general-${open.projectKey}`}
            project={open}
            onSaved={() => undefined}
          />
          <JiraSection key={`jira-${open.projectKey}`} project={open} />
          <MembersSection key={`members-${open.projectKey}`} projectKey={open.projectKey} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// (a) Thông tin chung
// ---------------------------------------------------------------------------

function GeneralSection({
  project,
  onSaved,
}: {
  /** `null` = form tạo dự án mới (key còn sửa được). */
  readonly project: ProjectView | null;
  readonly onSaved: (projectKey: string) => void;
}) {
  const upsert = useUpsertProject();
  const calendars = useBuiltinCalendars();

  const [projectKey, setProjectKey] = useState(project?.projectKey ?? '');
  const [displayName, setDisplayName] = useState(project?.displayName ?? '');
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? 'ACTIVE');
  const [hierarchyDepth, setHierarchyDepth] = useState(project?.hierarchyDepth ?? 2);
  const [timezone, setTimezone] = useState(project?.timezone ?? 'Asia/Ho_Chi_Minh');
  const [defaultCalendarId, setDefaultCalendarId] = useState(project?.defaultCalendarId ?? '');

  const depthOptions: number[] = [];
  for (let d = HIERARCHY_DEPTH_MIN; d <= HIERARCHY_DEPTH_MAX; d += 1) depthOptions.push(d);

  const submit = (): void => {
    const body: UpsertProjectRequest = {
      projectKey: projectKey.trim(),
      displayName: displayName.trim() === '' ? null : displayName.trim(),
      status,
      hierarchyDepth,
      timezone: timezone.trim(),
      defaultCalendarId: defaultCalendarId === '' ? null : defaultCalendarId,
    };
    upsert.mutate(body, { onSuccess: (saved) => onSaved(saved.projectKey) });
  };

  return (
    <section className="panel" aria-labelledby="general-title">
      <h2 className="panel__title" id="general-title">
        {project === null ? 'Thêm dự án' : `Thông tin chung · ${project.projectKey}`}
      </h2>

      {project === null ? (
        <label className="field">
          <span>Mã dự án (khớp key trên Jira, chữ HOA)</span>
          <input
            className="input input--code"
            value={projectKey}
            placeholder="PAY"
            aria-label="Mã dự án"
            onChange={(e) => setProjectKey(e.target.value)}
          />
        </label>
      ) : (
        // Key là danh tính của tenant — không đổi được sau khi tạo.
        <p className="panel__hint">
          Mã dự án <code>{project.projectKey}</code> là danh tính tenant, không đổi được.
        </p>
      )}

      <label className="field">
        <span>Tên hiển thị (không bắt buộc)</span>
        <input
          className="input"
          value={displayName}
          placeholder="Payments"
          aria-label="Tên hiển thị"
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Trạng thái</span>
        <select
          className="input"
          value={status}
          aria-label="Trạng thái dự án"
          onChange={(e) => setStatus(e.target.value as ProjectStatus)}
        >
          {PROJECT_STATUS.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {status === 'ARCHIVED' && (
        <p className="notice notice--error" role="alert">
          Dự án lưu trữ biến mất khỏi bộ chọn dự án của mọi người (kể cả ADMIN) và ngừng đồng bộ.
          Dữ liệu vẫn được giữ nguyên.
        </p>
      )}

      <label className="field">
        <span>Độ sâu cây ticket dưới Epic (1–4)</span>
        <select
          className="input"
          value={hierarchyDepth}
          aria-label="Độ sâu cây ticket"
          onChange={(e) => setHierarchyDepth(Number(e.target.value))}
        >
          {depthOptions.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      {/* Xem trước vai trò từng tầng — để Admin hiểu con số 1–4 nghĩa là gì
          trước khi lưu, thay vì đoán rồi thấy dữ liệu phân tầng sai. */}
      <p className="muted" role="status">
        {hierarchyPreview(hierarchyDepth)}
      </p>

      <label className="field">
        <span>Múi giờ (IANA, ví dụ Asia/Ho_Chi_Minh)</span>
        <input
          className="input"
          value={timezone}
          aria-label="Múi giờ"
          onChange={(e) => setTimezone(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Lịch làm việc mặc định cho Epic mới</span>
        <select
          className="input"
          value={defaultCalendarId}
          aria-label="Lịch mặc định"
          onChange={(e) => setDefaultCalendarId(e.target.value)}
        >
          <option value="">— không đặt (chọn tay khi thêm Epic) —</option>
          {(calendars.data?.calendars ?? []).map((c) => (
            <option key={c.calendarId} value={c.calendarId}>
              {c.calendarId} · {c.timezone}
            </option>
          ))}
          {/* Giá trị đã lưu nhưng không còn trong danh sách — vẫn hiện để thấy mà sửa. */}
          {defaultCalendarId !== '' &&
            calendars.data !== undefined &&
            !calendars.data.calendars.some((c) => c.calendarId === defaultCalendarId) && (
              <option value={defaultCalendarId}>{defaultCalendarId} (không rõ!)</option>
            )}
        </select>
      </label>

      {upsert.isError && <ErrorState error={upsert.error} title="Không lưu được dự án" />}
      {upsert.isSuccess && (
        <p className="notice notice--ok" role="status">
          Đã lưu <strong>{upsert.data.projectKey}</strong>.
        </p>
      )}

      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={projectKey.trim() === '' || upsert.isPending}
          onClick={submit}
        >
          {upsert.isPending ? 'Đang lưu…' : 'Lưu thông tin chung'}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// (b) Kết nối Jira
// ---------------------------------------------------------------------------

function JiraSection({ project }: { readonly project: ProjectView }) {
  const update = useUpdateProjectJira();
  const test = useTestProjectJira();

  const [jiraBaseUrl, setJiraBaseUrl] = useState(project.jiraBaseUrl ?? '');
  const [jiraEmail, setJiraEmail] = useState(project.jiraEmail ?? '');
  /** Ô token WRITE-ONLY: rỗng = giữ token cũ; gõ gì đó = thay token. */
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [fieldsRaw, setFieldsRaw] = useState('');
  const [fieldsError, setFieldsError] = useState<string | null>(null);

  const submit = (): void => {
    // fieldsConfig là JSON tự do (server kiểm bằng zod); rỗng = null.
    let fieldsConfig: unknown = null;
    if (fieldsRaw.trim() !== '') {
      try {
        fieldsConfig = JSON.parse(fieldsRaw);
      } catch {
        setFieldsError('Nội dung fieldsConfig không phải JSON hợp lệ — sửa rồi lưu lại.');
        return;
      }
    }
    setFieldsError(null);

    const body: UpdateProjectJiraRequest = {
      jiraBaseUrl: jiraBaseUrl.trim() === '' ? null : jiraBaseUrl.trim(),
      jiraEmail: jiraEmail.trim() === '' ? null : jiraEmail.trim(),
      fieldsConfig,
      // apiToken: không gửi trường = GIỮ token cũ; null = XOÁ; chuỗi = thay mới.
      ...(clearToken
        ? { apiToken: null }
        : token.trim() !== ''
          ? { apiToken: token.trim() }
          : {}),
    };
    update.mutate(
      { projectKey: project.projectKey, body },
      {
        onSuccess: () => {
          setToken('');
          setClearToken(false);
        },
      },
    );
  };

  return (
    <section className="panel" aria-labelledby="jira-title">
      <h2 className="panel__title" id="jira-title">
        Kết nối Jira · {project.projectKey}
      </h2>
      <p className="panel__hint">
        Mỗi tenant có thể trỏ tới một site Jira riêng. <strong>Để trống = dùng cấu hình chung từ
        biến môi trường</strong> (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN của server).
      </p>

      <label className="field">
        <span>Jira base URL</span>
        <input
          className="input input--wide"
          value={jiraBaseUrl}
          placeholder="https://your-site.atlassian.net"
          aria-label="Jira base URL"
          onChange={(e) => setJiraBaseUrl(e.target.value)}
        />
      </label>
      {/* Chốt an toàn phía server: token đã lưu KHÔNG đi theo URL mới. */}
      {project.hasJiraToken &&
        (jiraBaseUrl.trim() === '' ? null : jiraBaseUrl.trim()) !== project.jiraBaseUrl && (
          <p className="field-hint field-hint--warning">
            Đổi base URL sẽ <strong>tự xoá token đã lưu</strong> — nhập token mới bên dưới
            (token cũ không bao giờ được gửi sang site khác).
          </p>
        )}

      <label className="field">
        <span>Email tài khoản Jira</span>
        <input
          className="input input--wide"
          value={jiraEmail}
          placeholder="bot@your-company.com"
          aria-label="Email tài khoản Jira"
          onChange={(e) => setJiraEmail(e.target.value)}
        />
      </label>

      <label className="field">
        <span>API token (chỉ ghi — không bao giờ hiển thị lại)</span>
        <input
          className="input input--wide"
          type="password"
          value={token}
          disabled={clearToken}
          // Đã có token thì nói rõ; ô để trống khi lưu nghĩa là GIỮ token cũ.
          placeholder={project.hasJiraToken ? '•••• (đã lưu)' : 'chưa có token riêng'}
          aria-label="Jira API token"
          autoComplete="new-password"
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {project.hasJiraToken && (
        <label className="check">
          <input
            type="checkbox"
            checked={clearToken}
            onChange={(e) => setClearToken(e.target.checked)}
          />
          Xoá token đã lưu (quay về dùng token chung từ env)
        </label>
      )}

      <label className="field">
        <span>fieldsConfig (JSON, không bắt buộc — cùng dạng config/jira-fields.yaml)</span>
        <textarea
          className="input input--wide"
          rows={4}
          value={fieldsRaw}
          placeholder='{"wbsStartDate": "customfield_10015"}'
          aria-label="fieldsConfig JSON"
          onChange={(e) => setFieldsRaw(e.target.value)}
        />
      </label>
      {fieldsError !== null && (
        <p className="notice notice--error" role="alert">
          {fieldsError}
        </p>
      )}

      {update.isError && <ErrorState error={update.error} title="Không lưu được kết nối Jira" />}
      {update.isSuccess && (
        <p className="notice notice--ok" role="status">
          Đã lưu kết nối Jira. Bấm “Kiểm tra kết nối” để chắc chắn token dùng được.
        </p>
      )}

      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={update.isPending}
          onClick={submit}
        >
          {update.isPending ? 'Đang lưu…' : 'Lưu kết nối Jira'}
        </button>
        <button
          type="button"
          className="button"
          disabled={test.isPending}
          onClick={() => test.mutate(project.projectKey)}
        >
          {test.isPending ? 'Đang kiểm tra…' : '🔌 Kiểm tra kết nối'}
        </button>
      </div>

      {test.isError && <ErrorState error={test.error} title="Không chạy được bài kiểm tra kết nối" />}
      {test.isSuccess && (
        <ul className="rows" aria-label="Kết quả kiểm tra kết nối">
          {test.data.steps.map((step) => (
            <li className="row" key={step.step}>
              <Badge tone={step.ok ? 'success' : 'danger'}>{step.ok ? '✓' : '✗'}</Badge>
              <code>{step.step}</code>
              {/* detail hiện NGUYÊN VĂN — đó là thứ Admin cần để sửa. */}
              <span className={step.ok ? 'muted' : ''}>{step.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// (c) Thành viên
// ---------------------------------------------------------------------------

function MembersSection({ projectKey }: { readonly projectKey: string }) {
  const members = useProjectMembers(projectKey);
  const upsert = useUpsertMember();
  const remove = useRemoveMember();

  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<ProjectRole>('VIEWER');

  const submit = (): void => {
    upsert.mutate(
      { projectKey, body: { userId: userId.trim(), role } },
      { onSuccess: () => setUserId('') },
    );
  };

  return (
    <section className="panel" aria-labelledby="members-title">
      <h2 className="panel__title" id="members-title">
        Thành viên · {projectKey}
      </h2>
      <p className="panel__hint">
        <strong>PM</strong> cấu hình và thao tác ghi trong dự án; <strong>VIEWER</strong> chỉ xem.
        Người được thêm phải tồn tại ở màn Users trước (role toàn cục MEMBER là đủ).
      </p>

      {members.isPending ? (
        <LoadingState label="Đang tải thành viên…" rows={2} />
      ) : members.isError ? (
        <ErrorState
          error={members.error}
          title="Không tải được danh sách thành viên"
          onRetry={() => void members.refetch()}
        />
      ) : members.data.length === 0 ? (
        <EmptyState
          title="Chưa có thành viên"
          description="Thêm PM/VIEWER ở khung dưới để họ thấy dự án này."
        />
      ) : (
        <ul className="rows" aria-label="Thành viên dự án">
          {members.data.map((m) => (
            <li className="row" key={m.userId}>
              <code>{m.userId}</code>
              <Badge tone={m.role === 'PM' ? 'success' : 'neutral'}>{m.role}</Badge>
              {m.displayName !== null && <span>{m.displayName}</span>}
              <span className="muted" title={m.addedAt}>
                thêm bởi {m.addedBy}
              </span>

              <span className="row__spacer" />

              <button
                type="button"
                className="button button--danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ projectKey, userId: m.userId })}
              >
                Gỡ khỏi dự án
              </button>
            </li>
          ))}
        </ul>
      )}

      {remove.isError && <ErrorState error={remove.error} title="Không gỡ được thành viên" />}

      <div className="row">
        <input
          className="input input--wide"
          value={userId}
          placeholder="email@your-company.com"
          aria-label="Email thành viên"
          onChange={(e) => setUserId(e.target.value)}
        />
        <select
          className="input"
          value={role}
          aria-label="Role trong dự án"
          onChange={(e) => setRole(e.target.value as ProjectRole)}
        >
          {PROJECT_ROLE.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button--primary"
          disabled={userId.trim() === '' || upsert.isPending}
          onClick={submit}
        >
          {upsert.isPending ? 'Đang thêm…' : 'Thêm / cập nhật'}
        </button>
      </div>

      {upsert.isError && <ErrorState error={upsert.error} title="Không thêm được thành viên" />}
      {upsert.isSuccess && (
        <p className="notice notice--ok" role="status">
          Đã cập nhật thành viên.
        </p>
      )}
    </section>
  );
}
