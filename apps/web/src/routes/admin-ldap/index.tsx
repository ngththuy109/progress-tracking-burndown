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

/** Ba cách xác định user — khai ít nhất một bộ trường tương ứng. */
export type LdapBindMode = 'TEMPLATE' | 'DIRECT_SEARCH' | 'SEARCH';

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
 * Trường của CÁCH KHÔNG CHỌN gửi `null` tường minh (kể cả `bindPassword` khi
 * KHÔNG dùng search-then-bind — tài khoản dịch vụ không còn thì không giữ mật
 * khẩu của nó lại). `bindPassword` ở mode SEARCH giữ ba trạng thái: không gửi =
 * GIỮ; `null` = XÓA; chuỗi = thay mới.
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
  if (form.bindMode === 'DIRECT_SEARCH') {
    // AD direct-bind: template (bind bằng mật khẩu user) + search base/filter để
    // TỰ TRA email trên chính kết nối đó. Không có tài khoản dịch vụ → bindDn/
    // bindPassword đều null.
    return {
      ...base,
      userDnTemplate: trimOrNull(form.userDnTemplate),
      searchBase: trimOrNull(form.searchBase),
      userFilter: form.userFilter.trim() === '' ? DEFAULT_USER_FILTER : form.userFilter.trim(),
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
    return 'The server refused to ENABLE LDAP because the test has not passed — click "Test" below, fix the configuration until every step is green, then enable again.';
  }
  if (error.code === 'ENCRYPTION_KEY_MISSING') {
    return 'The server is missing the ENCRYPTION_KEY environment variable, so it cannot encrypt the bind password. Set ENCRYPTION_KEY for the API, restart it, then save again.';
  }
  if (error.status === 400) {
    return 'Pick how to locate the user: Direct bind (template DN), Direct bind + email lookup (template DN + search base, for AD), or Search then bind (search base + filter + service account).';
  }
  return null;
}

export function AdminLdapScreen() {
  const me = useMe();

  if (me.isPending) return <LoadingState label="Loading…" rows={2} />;
  if (me.data && me.data.role !== 'ADMIN') {
    return (
      <EmptyState
        icon="🔒"
        title="Admins only"
        description="Only Admins can configure LDAP login. Contact an administrator if you need access."
      />
    );
  }
  return <LdapManager />;
}

function LdapManager() {
  const query = useLdapConfig();

  if (query.isPending) return <LoadingState label="Loading LDAP configuration…" rows={3} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load LDAP configuration"
        onRetry={() => void query.refetch()}
      />
    );
  }

  // `key` theo updatedAt: lưu xong (updatedAt đổi) là form dựng lại từ bản
  // server vừa trả — ô mật khẩu về rỗng, checkbox xóa về tắt.
  return <LdapForm key={query.data.updatedAt ?? 'unsaved'} config={query.data} />;
}

function LdapForm({ config }: { readonly config: LdapConfigView }) {
  const update = useUpdateLdapConfig();
  const test = useTestLdap();

  const [enabled, setEnabled] = useState(config.enabled);
  const [serverUrl, setServerUrl] = useState(config.serverUrl ?? '');
  // Suy mode từ bản đã lưu: CÓ CẢ template lẫn searchBase → AD direct-bind + tự
  // tra email; chỉ searchBase → search-then-bind; còn lại → direct bind template.
  const [bindMode, setBindMode] = useState<LdapBindMode>(
    config.userDnTemplate !== null && config.searchBase !== null
      ? 'DIRECT_SEARCH'
      : config.searchBase !== null
        ? 'SEARCH'
        : 'TEMPLATE',
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
          LDAP login
        </h2>
        <p className="panel__hint">
          When enabled, the app signs users in with a username/password form (authenticated
          through LDAP) instead of a header from a gateway/proxy. After configuring, click{' '}
          <strong>Test</strong> before enabling.
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
          Use <code>ldaps://</code> (TLS) whenever possible; <code>ldap://</code> sends the
          password over the network unencrypted.
        </p>

        {/* --- Cách xác định user ------------------------------------------ */}
        <fieldset className="field">
          <legend>How to locate the user</legend>
          <label className="choice">
            <input
              type="radio"
              name="ldap-bind-mode"
              checked={bindMode === 'TEMPLATE'}
              onChange={() => setBindMode('TEMPLATE')}
              aria-label="Direct bind (template DN)"
            />
            <span>
              <strong>Direct bind (template DN)</strong> — build the DN from the username and
              bind directly. Fits OpenLDAP with regular DNs.
            </span>
          </label>
          <label className="choice">
            <input
              type="radio"
              name="ldap-bind-mode"
              checked={bindMode === 'DIRECT_SEARCH'}
              onChange={() => setBindMode('DIRECT_SEARCH')}
              aria-label="Direct bind + email lookup (Active Directory)"
            />
            <span>
              <strong>Direct bind + email lookup (Active Directory)</strong> — bind with the
              user's OWN password (e.g. <code>congty.vn\{'{username}'}</code>), then look up the
              email over that same connection. No service account needed.
            </span>
          </label>
          <label className="choice">
            <input
              type="radio"
              name="ldap-bind-mode"
              checked={bindMode === 'SEARCH'}
              onChange={() => setBindMode('SEARCH')}
              aria-label="Search then bind (Active Directory)"
            />
            <span>
              <strong>Search then bind (Active Directory)</strong> — a service account finds
              the user by filter, then binds with the DN found. The standard approach for AD.
            </span>
          </label>
        </fieldset>

        {(bindMode === 'TEMPLATE' || bindMode === 'DIRECT_SEARCH') && (
          <label className="field">
            <span>
              Template DN (contains <code>{'{username}'}</code>)
            </span>
            <input
              className="input input--wide input--code"
              value={userDnTemplate}
              placeholder={
                bindMode === 'DIRECT_SEARCH'
                  ? 'congty.vn\\{username}'
                  : 'uid={username},ou=users,dc=congty,dc=vn'
              }
              aria-label="Template DN"
              onChange={(e) => setUserDnTemplate(e.target.value)}
            />
          </label>
        )}
        {bindMode === 'DIRECT_SEARCH' && (
          <p className="field-hint">
            The app binds with the user's own password using the template above (AD accepts{' '}
            <code>{'DOMAIN\\{username}'}</code> or the UPN <code>{'{username}@congty.vn'}</code>),
            then looks up the email over that same connection — no service account needed. Fill
            in Search base + User filter below to look up the email.
          </p>
        )}

        {(bindMode === 'DIRECT_SEARCH' || bindMode === 'SEARCH') && (
          <>
            <label className="field">
              <span>Search base</span>
              <input
                className="input input--wide input--code"
                value={searchBase}
                placeholder="dc=congty,dc=vn"
                aria-label="Search base"
                onChange={(e) => setSearchBase(e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                User filter (contains <code>{'{username}'}</code>)
              </span>
              <input
                className="input input--wide input--code"
                value={userFilter}
                placeholder="(sAMAccountName={username})"
                aria-label="User filter"
                onChange={(e) => setUserFilter(e.target.value)}
              />
            </label>
          </>
        )}

        {bindMode === 'SEARCH' && (
          <>
            <label className="field">
              <span>Bind DN (service account)</span>
              <input
                className="input input--wide input--code"
                value={bindDn}
                placeholder="cn=svc-burndown,ou=service,dc=congty,dc=vn"
                aria-label="Bind DN"
                onChange={(e) => setBindDn(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Bind password (write-only — never shown again)</span>
              <input
                className="input input--wide"
                type="password"
                value={bindPassword}
                disabled={clearBindPassword}
                // Đã có mật khẩu thì nói rõ; để trống khi lưu nghĩa là GIỮ bản cũ.
                placeholder={config.hasBindPassword ? '•••• (saved)' : 'no password set'}
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
                Clear saved bind password
              </label>
            )}
          </>
        )}

        {/* --- Các thiết lập chung ----------------------------------------- */}
        <label className="field">
          <span>Email attribute</span>
          <input
            className="input input--code"
            value={emailAttribute}
            placeholder="mail"
            aria-label="Email attribute"
            onChange={(e) => setEmailAttribute(e.target.value)}
          />
        </label>
        <p className="field-hint">
          The LDAP attribute holding the email — this email is the userId in the app (must match
          the Users/members list). Active Directory: <code>mail</code> or{' '}
          <code>userPrincipalName</code>.
        </p>

        <label className="field">
          <span>Session lifetime (hours, 1–168)</span>
          <input
            className="input input--number"
            type="number"
            min={1}
            max={168}
            value={ttlRaw}
            aria-label="Session lifetime (hours)"
            onChange={(e) => setTtlRaw(e.target.value)}
          />
        </label>
        {!ttlValid && (
          <p className="field-hint field-hint--warning">
            Session lifetime must be an integer between 1 and 168 hours (7 days).
          </p>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={allowSelfSigned}
            onChange={(e) => setAllowSelfSigned(e.target.checked)}
          />
          Accept self-signed certificate
        </label>
        {allowSelfSigned && (
          <p className="field-hint field-hint--warning">
            Skips TLS certificate verification — use only when the LDAP server is on a trusted
            internal network. Prefer installing the internal CA certificate for the API over
            enabling this.
          </p>
        )}

        {/* --- Công tắc bật + lối thoát ------------------------------------- */}
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <strong>Enable LDAP login</strong>
        </label>
        {enabled && (
          <p className="notice notice--warning" role="alert">
            Enabling LDAP will <strong>TURN OFF header/gateway login</strong> — only enable after
            the Test passes. If you lock yourself out: set <code>AUTH_FORCE_HEADER=1</code> and
            restart the API to return to header mode.
          </p>
        )}

        {update.isError && (
          <ErrorState error={update.error} title="Could not save LDAP configuration" />
        )}
        {saveHint !== null && (
          <p className="notice notice--warning" role="alert">
            {saveHint}
          </p>
        )}
        {update.isSuccess && (
          <p className="notice notice--ok" role="status">
            LDAP configuration saved.
          </p>
        )}

        {(config.updatedBy !== null || config.updatedAt !== null) && (
          <p className="muted">
            Last updated{config.updatedBy !== null ? ` by ${config.updatedBy}` : ''}
            {config.updatedAt !== null ? ` at ${config.updatedAt}` : ''}.
          </p>
        )}

        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={test.isPending || !ttlValid}
            onClick={() => test.mutate(body())}
          >
            {test.isPending ? 'Testing…' : '🔌 Test'}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={update.isPending || !ttlValid}
            onClick={() => update.mutate(body())}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>

        {test.isError && <ErrorState error={test.error} title="Could not run the LDAP test" />}
        {test.isSuccess && (
          <>
            <p className={test.data.ok ? 'notice notice--ok' : 'notice notice--error'} role="status">
              {test.data.ok
                ? 'Test passed — you can enable LDAP login.'
                : 'Test did not pass — fix the configuration using the step details below.'}
            </p>
            <ul className="rows" aria-label="LDAP test result">
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
