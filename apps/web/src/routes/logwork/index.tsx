import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  STATUS_CATEGORY_LABEL,
  type LogworkMember,
  type LogworkTicket,
  type StatusCategory,
} from '@app/shared';
import { useMe } from '../../api/use-me.js';
import {
  useLogwork,
  useUnverifyExemption,
  useVerifyExemption,
} from '../../api/use-logwork.js';
import { IssueLink } from '../../components/issue-link/index.js';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  type BadgeTone,
  type Column,
} from '../../components/ui/index.js';
import { PeriodPicker } from './period-picker.js';
import { CapacitySettings } from './capacity-settings.js';
import { PicDailyGrid } from './pic-daily-grid.js';
import { EMPTY_FILTER, filterMembers, isFilterActive } from './filter-members.js';

/**
 * Màn hình "Log work" — TOÀN ĐỘI.
 *
 * Hai cách nhìn cùng một kỳ, chọn bằng thanh "View":
 *  - "By member": ai chưa log work trong kỳ? Trên ticket đang mở nào họ đang
 *    in-charge (Request participants của Jira)? PM có thể "verify — thôi theo
 *    dõi" một cặp (member, ticket) để tắt cờ.
 *  - "By PIC / day": lưới PIC × ngày — số giờ mỗi người log MỖI NGÀY, tô cảnh
 *    báo ô `<= 4h` (thiếu) hoặc `> 8h` (quá).
 *
 * Kỳ (`from`/`to`) và cách nhìn (`view`) đều nằm trên URL nên chia sẻ được và
 * giữ nguyên khi đổi qua lại giữa hai tab.
 */

type View = 'members' | 'grid';

const STATUS_TONE: Record<StatusCategory, BadgeTone> = {
  new: 'neutral',
  indeterminate: 'info',
  done: 'success',
};

/** 3600s = 1h; bỏ số 0 thừa (`1.50` → `1.5`, `8` vẫn `8`). */
function formatHours(hours: number): string {
  return String(Number(hours.toFixed(2)));
}

export function LogworkScreen() {
  const [params, setParams] = useSearchParams();
  const from = params.get('from');
  const to = params.get('to');
  const view: View = params.get('view') === 'grid' ? 'grid' : 'members';

  // Đổi kỳ giữ nguyên tab; đổi tab giữ nguyên kỳ. `setParams` thay TOÀN BỘ query
  // nên phải tự chép lại tham số bên kia mỗi lần.
  const applyPeriod = (f: string | null, t: string | null): void => {
    const next: Record<string, string> = {};
    if (f !== null) next.from = f;
    if (t !== null) next.to = t;
    if (view === 'grid') next.view = 'grid';
    setParams(next);
  };
  const setView = (v: View): void => {
    const next: Record<string, string> = {};
    if (from !== null) next.from = from;
    if (to !== null) next.to = to;
    if (v === 'grid') next.view = 'grid';
    setParams(next);
  };

  const viewTab = (key: View, label: string) => (
    <button
      type="button"
      className={`tab${view === key ? ' tab--active' : ''}`}
      aria-pressed={view === key}
      onClick={() => setView(key)}
    >
      {label}
    </button>
  );

  return (
    <div className="stack">
      <div className="scope" role="group" aria-label="Report view">
        <span className="scope__label">View:</span>
        <div className="tabs">
          {viewTab('members', 'By member')}
          {viewTab('grid', 'By PIC / day')}
        </div>
      </div>

      {view === 'grid' ? (
        <PicDailyGrid from={from} to={to} onChangePeriod={applyPeriod} />
      ) : (
        <MembersView from={from} to={to} onChangePeriod={applyPeriod} />
      )}
    </div>
  );
}

function MembersView({
  from,
  to,
  onChangePeriod,
}: {
  readonly from: string | null;
  readonly to: string | null;
  readonly onChangePeriod: (from: string | null, to: string | null) => void;
}) {
  const [filter, setFilter] = useState(EMPTY_FILTER);

  const query = useLogwork(from, to);
  const me = useMe();
  const role = me.data?.role ?? 'VIEWER';
  const myProjects = me.data?.projects ?? [];
  const canVerify = (projectKey: string): boolean =>
    role === 'ADMIN' || (role === 'PM' && myProjects.includes(projectKey));

  if (query.isPending) return <LoadingState label="Loading log work…" rows={5} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load log work"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const data = query.data;
  const members = filterMembers(data.members, filter);
  const filtering = isFilterActive(filter);
  // `isPending` đã thoát ở trên; còn `isFetching` ở đây là đang tải kỳ MỚI trong
  // khi vẫn hiện dữ liệu kỳ trước (nhờ `keepPreviousData`).
  const refreshing = query.isFetching;

  return (
    <>
      <PeriodPicker
        from={from}
        to={to}
        rangeFrom={data.from}
        rangeTo={data.to}
        partialPeriod={data.partialPeriod}
        onChange={onChangePeriod}
      />

      <div className="scope">
        <input
          className="input input--wide"
          type="search"
          placeholder="Search member, ticket key, or summary…"
          value={filter.term}
          aria-label="Search members and tickets"
          onChange={(e) => setFilter((f) => ({ ...f, term: e.target.value }))}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={filter.notLoggedOnly}
            onChange={(e) => setFilter((f) => ({ ...f, notLoggedOnly: e.target.checked }))}
          />
          Only not logged
        </label>
        {refreshing && (
          <span className="muted" role="status" aria-live="polite">
            Updating…
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <CapacitySettings />
        </span>
      </div>

      <p className="muted">
        {data.totalMembers} member{data.totalMembers === 1 ? '' : 's'} · {data.totalNotLogged} not logging
        · {data.visibleEpicCount} epic{data.visibleEpicCount === 1 ? '' : 's'} you can see
      </p>

      {data.warnings.map((w) => (
        <p key={w} className="notice notice--warning">
          {w}
        </p>
      ))}

      {!data.hasParticipantData && (
        <p className="notice notice--warning" role="note">
          No “in charge” data for this period. Either the <strong>Request participants</strong> field is
          not enabled in <code>config/jira-fields.yaml</code>, or these sub-tasks have no participants.
          Members who logged time are still listed below.
        </p>
      )}

      {members.length === 0 ? (
        <EmptyState
          icon="🔍"
          title={filtering ? 'No member matches those conditions' : 'No members in view'}
          description={
            filtering
              ? 'Clear the search box and the “Only not logged” filter to see everyone again.'
              : 'No tracked Epic you can see has participants or worklog in this period.'
          }
        />
      ) : (
        members.map((m) => <MemberCard key={m.accountId} member={m} canVerify={canVerify} />)
      )}
    </>
  );
}

function MemberCard({
  member,
  canVerify,
}: {
  readonly member: LogworkMember;
  readonly canVerify: (projectKey: string) => boolean;
}) {
  // Member cần chú ý (còn ticket chưa log) mở sẵn để thấy ngay.
  const [open, setOpen] = useState(member.notLoggedCount > 0);
  const verify = useVerifyExemption();
  const unverify = useUnverifyExemption();
  const busy = verify.isPending || unverify.isPending;

  const columns: readonly Column<LogworkTicket>[] = [
    {
      key: 'issue',
      header: 'Sub-task',
      render: (t) => (
        <span>
          <IssueLink issueKey={t.issueKey} /> {t.summary}
        </span>
      ),
      sortKey: (t) => t.issueKey,
    },
    { key: 'epic', header: 'Epic', render: (t) => <IssueLink issueKey={t.epicKey} />, sortKey: (t) => t.epicKey },
    { key: 'phase', header: 'Phase', render: (t) => t.phaseCode, sortKey: (t) => t.phaseCode },
    {
      key: 'status',
      header: 'Status',
      render: (t) => <Badge tone={STATUS_TONE[t.statusCategory]}>{STATUS_CATEGORY_LABEL[t.statusCategory]}</Badge>,
      sortKey: (t) => t.statusCategory,
    },
    {
      key: 'estimate',
      header: 'Est (h)',
      align: 'right',
      render: (t) => formatHours(t.originalEstimateHours),
      sortKey: (t) => t.originalEstimateHours,
    },
    {
      key: 'logged',
      header: 'Logged (them)',
      align: 'right',
      render: (t) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatHours(t.memberLoggedHours)}
          {t.memberLoggedHours === 0 && t.totalLoggedHours > 0 && (
            <span className="muted"> / {formatHours(t.totalLoggedHours)}</span>
          )}
        </span>
      ),
      sortKey: (t) => t.memberLoggedHours,
    },
    {
      key: 'flag',
      header: 'Follow-up',
      render: (t) => (
        <FlagCell
          ticket={t}
          canVerify={canVerify(t.projectKey)}
          busy={busy}
          onVerify={() => verify.mutate({ accountId: member.accountId, issueKey: t.issueKey })}
          onUnverify={() => unverify.mutate({ accountId: member.accountId, issueKey: t.issueKey })}
        />
      ),
    },
  ];

  return (
    <section className="panel">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          background: 'none',
          border: 0,
          font: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
          padding: 0,
        }}
      >
        <span aria-hidden="true" className="muted">
          {open ? '▾' : '▸'}
        </span>
        <strong>{member.displayName ?? <code>{member.accountId}</code>}</strong>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <CapacityMeter logged={member.totalLoggedHours} expected={member.expectedHours} />
          <MemberBadges member={member} />
        </span>
      </button>

      {open &&
        (member.tickets.length === 0 ? (
          <p className="panel__hint">
            Logged {formatHours(member.totalLoggedHours)}h this period, but not in charge of any open ticket.
          </p>
        ) : (
          <DataTable
            caption={`Open in-charge tickets for ${member.displayName ?? member.accountId}`}
            columns={columns}
            rows={member.tickets}
            rowKey={(t) => t.issueKey}
          />
        ))}
    </section>
  );
}

function MemberBadges({ member }: { readonly member: LogworkMember }): ReactNode {
  return (
    <>
      {member.behind && <Badge tone="danger">behind {formatHours(member.deficitHours)}h</Badge>}
      {member.notLoggedCount > 0 ? (
        <Badge tone="danger">{member.notLoggedCount} not logged</Badge>
      ) : (
        member.hasOpenAssignments && <Badge tone="success">all logged</Badge>
      )}
      {member.exemptedCount > 0 && <Badge tone="info">{member.exemptedCount} verified</Badge>}
      {!member.hasOpenAssignments && <Badge tone="warning">logged, not assigned</Badge>}
    </>
  );
}

function CapacityMeter({ logged, expected }: { readonly logged: number; readonly expected: number }): ReactNode {
  if (expected <= 0) {
    return <span className="muted">{formatHours(logged)}h logged</span>;
  }
  const ratio = Math.min(1, logged / expected);
  const color = ratio >= 1 ? 'var(--tone-success)' : ratio >= 0.5 ? 'var(--tone-warning)' : 'var(--tone-danger)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        aria-hidden="true"
        style={{
          width: 80,
          height: 7,
          borderRadius: 999,
          background: 'var(--tone-neutral-bg)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        <span style={{ display: 'block', height: '100%', width: `${ratio * 100}%`, background: color }} />
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }} className="muted">
        {formatHours(logged)} / {formatHours(expected)}h
      </span>
    </span>
  );
}

function FlagCell({
  ticket,
  canVerify,
  busy,
  onVerify,
  onUnverify,
}: {
  readonly ticket: LogworkTicket;
  readonly canVerify: boolean;
  readonly busy: boolean;
  readonly onVerify: () => void;
  readonly onUnverify: () => void;
}): ReactNode {
  if (ticket.exempted) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Badge tone="success" title={ticket.exemptedBy === null ? undefined : `Verified by ${ticket.exemptedBy}`}>
          ✔ verified
        </Badge>
        {canVerify && (
          <button type="button" className="button button--icon" disabled={busy} onClick={onUnverify}>
            undo
          </button>
        )}
      </span>
    );
  }
  if (ticket.notLogged) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Badge tone="danger">⚠ no worklog</Badge>
        {canVerify ? (
          <button type="button" className="button button--icon" disabled={busy} onClick={onVerify}>
            ✓ verify
          </button>
        ) : (
          <span className="muted" title="Only this project’s PM or an admin can verify">
            PM verifies
          </span>
        )}
      </span>
    );
  }
  return <Badge tone="success">✓ logged</Badge>;
}
