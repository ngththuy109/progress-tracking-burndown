import { useState } from 'react';
import type { LdapConfigView, UpdateLdapConfigRequest } from '@app/shared';
import { ApiError } from '../../api/client.js';
import { useMe } from '../../api/use-me.js';
import { useLdapConfig, useTestLdap, useUpdateLdapConfig } from '../../api/use-ldap.js';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/ui/index.js';

/**
 * Màn hình cấu hình đăng nhập LDAP — chỉ ADMIN.
 *
 * Nguy hiểm nhất của màn hình này là TỰ KHÓA MÌNH RA NGOÀI: bật LDAP với cấu
 * hình hỏng là không ai đăng nhập được nữa. Ba lớp chống:
 *   1. Nút "Test" chạy CONNECT → BIND → SEARCH với giá trị ĐANG GÕ trên form.
 *   2. Server từ chối `enabled: true` khi test chưa pass (400 LDAP_TEST_FAILED).
 *   3. Cảnh báo lối thoát `AUTH_FORCE_HEADER=1` ngay cạnh công tắc bật.
 */

/** Hai cách xác định DN của user — khai đúng MỘT trong hai. */
export type LdapBindMode = 'TEMPLATE' | 'SEARCH';

/** `userFilter` không được null trong schema — mode direct-bind gửi mặc định này. */
const DEFAULT_USER_FILTER = '(mail={username})';

/** Trạng thái form — tách khỏi component để build body test được thuần túy. */
export interface LdapFormState {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly bindMode: LdapBindMode;
  readonly userDnTemplate: string;
  readonly searchBase: string;
  readonly userFilter: string;
  readonly bindDn: string;
  /** Ô write-only: rỗng = không đổi. */
  readonly bindPassword: string;
  readonly clearBindPassword: boolean;
  readonly emailAttribute: string;
  readonly sessionTtlHours: number;
  readonly allowSelfSigned: boolean;
}

const trimOrNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());

/**
 * Ghép body cho cả PUT lẫn POST test.
 *
 * Theo đúng hợp đồng "exactly-one-of": các trường của CÁCH KHÔNG CHỌN gửi
 * `null` tường minh (kể cả `bindPassword` khi chuyển sang direct-bind — tài
 * khoản dịch vụ không còn được dùng thì không giữ mật khẩu của nó lại).
 * `bindPassword` ở mode search giữ ba trạng thái: không gửi = GIỮ; `null` =
 * XÓA; chuỗi = thay mới.
 */
export function buildLdapBody(form: LdapFormState): UpdateLdapConfigRequest {
  const base = {
    enabled: form.enabled,
    serverUrl: trimOrNull(form.serverUrl),
    emailAttribute: form.emailAttribute.trim() === '' ? 'mail' : form.emailAttribute.trim(),
    allowSelfSigned: form.allowSelfSigned,
    sessionTtlHours: form.sessionTtlHours,
  };
  if (form.bindMode === 'TEMPLATE') {
    return {
      ...base,
      userDnTemplate: trimOrNull(form.userDnTemplate),
      searchBase: null,
      userFilter: DEFAULT_USER_FILTER,
      bindDn: null,
      bindPassword: null,
    };
  }
  return {
    ...base,
    userDnTemplate: null,
    searchBase: trimOrNull(form.searchBase),
    userFilter: form.userFilter.trim() === '' ? DEFAULT_USER_FILTER : form.userFilter.trim(),
    bindDn: trimOrNull(form.bindDn),
    ...(form.clearBindPassword
      ? { bindPassword: null }
      : form.bindPassword !== ''
        ? { bindPassword: form.bindPassword }
        : {}),
  };
}

/**
 * Câu giải thích THÊM cho các lỗi lưu đặc thù của LDAP — hiện kèm `ErrorState`
 * (vốn chỉ in message thô của server) để Admin biết bước tiếp theo là gì.
 */
export function ldapSaveHint(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'LDAP_TEST_FAILED') {
    return 'Server từ chối BẬT LDAP vì bài test chưa pass — bấm "Test" bên dưới, sửa cấu hình tới khi mọi bước xanh rồi mới bật lại.';
  }
  if (error.code === 'ENCRYPTION_KEY_MISSING') {
    return 'Server thiếu biến môi trường ENCRYPTION_KEY nên không mã hóa được bind password. Đặt ENCRYPTION_KEY cho API, khởi động lại, rồi lưu lại.';
  }
  if (error.status === 400) {
    return 'Khai đúng MỘT trong hai cách xác định user: Direct bind (template DN) HOẶC Search rồi bind (search base + filter) — không được cả hai, không được thiếu cả hai.';
  }
  return null;
}

export function AdminLdapScreen() {
  const me = useMe();

  if (me.isPending) return <LoadingState label="Đang tải…" rows={2} />;
  if (me.data && !me.data.isAdmin) {
    return (
      <EmptyState
        icon="🔒"
        title="Chỉ dành cho quản trị viên"
        description="Chỉ ADMIN cấu hình được đăng nhập LDAP. Liên hệ quản trị viên nếu bạn cần quyền."
      />
    );
  }
  return <LdapManager />;
}

function LdapManager() {
  const query = useLdapConfig();

  if (query.isPending) return <LoadingState label="Đang tải cấu hình LDAP…" rows={3} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Không tải được cấu hình LDAP"
        onRetry={() => void query.refetch()}
      />
    );
  }

  // `key` theo updatedAt: lưu xong (updatedAt đổi) là form dựng lại từ bản
  // server vừa trả — ô mật khẩu về rỗng, checkbox xóa về tắt.
  return <LdapForm key={query.data.updatedAt ?? 'chưa-lưu'} config={query.data} />;
}

function LdapForm({ config }: { readonly config: LdapConfigView }) {
  const update = useUpdateLdapConfig();
  const test = useTestLdap();

  const [enabled, setEnabled] = useState(config.enabled);
  const [serverUrl, setServerUrl] = useState(config.serverUrl ?? '');
  // Bản đã lưu có searchBase (mà không có template) → đang dùng search-bind.
  const [bindMode, setBindMode] = useState<LdapBindMode>(
    config.searchBase !== null && config.userDnTemplate === null ? 'SEARCH' : 'TEMPLATE',
  );
  const [userDnTemplate, setUserDnTemplate] = useState(config.userDnTemplate ?? '');
  const [searchBase, setSearchBase] = useState(config.searchBase ?? '');
  const [userFilter, setUserFilter] = useState(config.userFilter);
  const [bindDn, setBindDn] = useState(config.bindDn ?? '');
  const [bindPassword, setBindPassword] = useState('');
  const [clearBindPassword, setClearBindPassword] = useState(false);
  const [emailAttribute, setEmailAttribute] = useState(config.emailAttribute);
  const [ttlRaw, setTtlRaw] = useState(String(config.sessionTtlHours));
  const [allowSelfSigned, setAllowSelfSigned] = useState(config.allowSelfSigned);

  const ttl = Number(ttlRaw);
  const ttlValid = Number.isInteger(ttl) && ttl >= 1 && ttl <= 168;

  const body = (): UpdateLdapConfigRequest =>
    buildLdapBody({
      enabled,
      serverUrl,
      bindMode,
      userDnTemplate,
      searchBase,
      userFilter,
      bindDn,
      bindPassword,
      clearBindPassword,
      emailAttribute,
      sessionTtlHours: ttl,
      allowSelfSigned,
    });

  const saveHint = ldapSaveHint(update.error);

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="ldap-title">
        <h2 className="panel__title" id="ldap-title">
          Đăng nhập LDAP
        </h2>
        <p className="panel__hint">
          Khi bật, app tự đăng nhập bằng form tên/mật khẩu (xác thực qua LDAP) thay cho
          header từ cổng/proxy. Cấu hình xong hãy bấm <strong>Test</strong> trước khi bật.
        </p>

        <label className="field">
          <span>Server URL</span>
          <input
            className="input input--wide"
            value={serverUrl}
            placeholder="ldaps://ldap.congty.vn:636"
            aria-label="LDAP server URL"
            onChange={(e) => setServerUrl(e.target.value)}
          />
        </label>
        <p className="field-hint">
          Dùng <code>ldaps://</code> (TLS) khi có thể; <code>ldap://</code> gửi mật khẩu
          không mã hóa qua mạng.
        </p>

        {/* --- Cách xác định user ------------------------------------------ */}
        <fieldset className="field">
          <legend>Cách xác định user</legend>
          <label className="choice">
            <input
              type="radio"
              name="ldap-bind-mode"
              checked={bindMode === 'TEMPLATE'}
              onChange={() => setBindMode('TEMPLATE')}
              aria-label="Direct bind (template DN)"
            />
            <span>
              <strong>Direct bind (template DN)</strong> — ghép DN từ tên đăng nhập rồi bind
              thẳng. Phù hợp OpenLDAP có DN đều đặn.
            </span>
          </label>
          <label className="choice">
            <input
              type="radio"
              name="ldap-bind-mode"
              checked={bindMode === 'SEARCH'}
              onChange={() => setBindMode('SEARCH')}
              aria-label="Search rồi bind (Active Directory)"
            />
            <span>
              <strong>Search rồi bind (Active Directory)</strong> — tài khoản dịch vụ tìm user
              theo filter, rồi bind bằng DN tìm được. Cách chuẩn với AD.
            </span>
          </label>
        </fieldset>

        {bindMode === 'TEMPLATE' ? (
          <>
            <label className="field">
              <span>
                Template DN (chứa <code>{'{username}'}</code>)
              </span>
              <input
                className="input input--wide input--code"
                value={userDnTemplate}
                placeholder="uid={username},ou=users,dc=congty,dc=vn"
                aria-label="Template DN"
                onChange={(e) => setUserDnTemplate(e.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span>Search base</span>
              <input
                className="input input--wide input--code"
                value={searchBase}
                placeholder="ou=users,dc=congty,dc=vn"
                aria-label="Search base"
                onChange={(e) => setSearchBase(e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                User filter (chứa <code>{'{username}'}</code>)
              </span>
              <input
                className="input input--wide input--code"
                value={userFilter}
                placeholder="(sAMAccountName={username})"
                aria-label="User filter"
                onChange={(e) => setUserFilter(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Bind DN (tài khoản dịch vụ)</span>
              <input
                className="input input--wide input--code"
                value={bindDn}
                placeholder="cn=svc-burndown,ou=service,dc=congty,dc=vn"
                aria-label="Bind DN"
                onChange={(e) => setBindDn(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Bind password (chỉ ghi — không bao giờ hiển thị lại)</span>
              <input
                className="input input--wide"
                type="password"
                value={bindPassword}
                disabled={clearBindPassword}
                // Đã có mật khẩu thì nói rõ; để trống khi lưu nghĩa là GIỮ bản cũ.
                placeholder={config.hasBindPassword ? '•••• (đã lưu)' : 'chưa có mật khẩu'}
                aria-label="Bind password"
                autoComplete="new-password"
                onChange={(e) => setBindPassword(e.target.value)}
              />
            </label>
            {config.hasBindPassword && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={clearBindPassword}
                  onChange={(e) => setClearBindPassword(e.target.checked)}
                />
                Xóa bind password đã lưu
              </label>
            )}
          </>
        )}

        {/* --- Các thiết lập chung ----------------------------------------- */}
        <label className="field">
          <span>Thuộc tính email</span>
          <input
            className="input input--code"
            value={emailAttribute}
            placeholder="mail"
            aria-label="Thuộc tính email"
            onChange={(e) => setEmailAttribute(e.target.value)}
          />
        </label>
        <p className="field-hint">
          Thuộc tính LDAP chứa email — email này là userId trong app (phải khớp danh sách
          Users/thành viên). Active Directory: <code>mail</code> hoặc{' '}
          <code>userPrincipalName</code>.
        </p>

        <label className="field">
          <span>Thời hạn phiên (giờ, 1–168)</span>
          <input
            className="input input--number"
            type="number"
            min={1}
            max={168}
            value={ttlRaw}
            aria-label="Thời hạn phiên (giờ)"
            onChange={(e) => setTtlRaw(e.target.value)}
          />
        </label>
        {!ttlValid && (
          <p className="field-hint field-hint--warning">
            Thời hạn phiên phải là số nguyên từ 1 đến 168 giờ (7 ngày).
          </p>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={allowSelfSigned}
            onChange={(e) => setAllowSelfSigned(e.target.checked)}
          />
          Chấp nhận chứng chỉ tự ký (self-signed)
        </label>
        {allowSelfSigned && (
          <p className="field-hint field-hint--warning">
            Bỏ kiểm tra chứng chỉ TLS — chỉ dùng khi máy chủ LDAP nằm trong mạng nội bộ tin
            cậy. Ưu tiên cài chứng chỉ CA nội bộ cho API thay vì bật mục này.
          </p>
        )}

        {/* --- Công tắc bật + lối thoát ------------------------------------- */}
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <strong>Bật đăng nhập LDAP</strong>
        </label>
        {enabled && (
          <p className="notice notice--warning" role="alert">
            Bật LDAP sẽ <strong>TẮT đăng nhập qua header/cổng</strong> — chỉ bật sau khi Test
            pass. Nếu tự khóa mình ở ngoài: đặt <code>AUTH_FORCE_HEADER=1</code> rồi khởi
            động lại API để quay về chế độ header.
          </p>
        )}

        {update.isError && (
          <ErrorState error={update.error} title="Không lưu được cấu hình LDAP" />
        )}
        {saveHint !== null && (
          <p className="notice notice--warning" role="alert">
            {saveHint}
          </p>
        )}
        {update.isSuccess && (
          <p className="notice notice--ok" role="status">
            Đã lưu cấu hình LDAP.
          </p>
        )}

        {(config.updatedBy !== null || config.updatedAt !== null) && (
          <p className="muted">
            Cập nhật lần cuối{config.updatedBy !== null ? ` bởi ${config.updatedBy}` : ''}
            {config.updatedAt !== null ? ` lúc ${config.updatedAt}` : ''}.
          </p>
        )}

        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={test.isPending || !ttlValid}
            onClick={() => test.mutate(body())}
          >
            {test.isPending ? 'Đang test…' : '🔌 Test'}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={update.isPending || !ttlValid}
            onClick={() => update.mutate(body())}
          >
            {update.isPending ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>

        {test.isError && <ErrorState error={test.error} title="Không chạy được bài test LDAP" />}
        {test.isSuccess && (
          <>
            <p className={test.data.ok ? 'notice notice--ok' : 'notice notice--error'} role="status">
              {test.data.ok
                ? 'Test pass — có thể bật đăng nhập LDAP.'
                : 'Test CHƯA pass — sửa cấu hình theo chi tiết từng bước bên dưới.'}
            </p>
            <ul className="rows" aria-label="Kết quả test LDAP">
              {test.data.steps.map((step) => (
                <li className="row" key={step.step}>
                  <Badge tone={step.ok ? 'success' : 'danger'}>{step.ok ? '✓' : '✗'}</Badge>
                  <code>{step.step}</code>
                  {/* detail hiện NGUYÊN VĂN — đó là thứ Admin cần để sửa. */}
                  <span className={step.ok ? 'muted' : ''}>{step.detail}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
