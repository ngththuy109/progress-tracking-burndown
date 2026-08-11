import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  SIGNBOARD_STATUS,
  type SignboardCell,
  type SignboardColumnGroup,
  type SignboardRow,
  type SignboardStatus,
} from '@app/shared';
import { useSignboard, useSignboardPhases, useUnparsedSubtasks } from '../../api/use-signboard.js';
import { usePlanConflicts } from '../../api/use-plan-conflicts.js';
import { EpicPicker } from '../../components/epic-picker/index.js';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/ui/index.js';
import { SignboardCellView, STATUS_LABEL } from './signboard-cell.js';
import { jiraBaseUrl } from '../../api/jira.js';
import type { PlanConflict } from '@app/shared';

/**
 * Base URL Jira cho các link "mở ticket" trong ô. Đọc MỘT lần (biến Vite tĩnh);
 * `''` = chưa cấu hình → ô chỉ cho copy mã, không mở thẳng sang Jira.
 */
const JIRA_BASE = jiraBaseUrl();

/**
 * Bảng Signboard — PRD §6.
 *
 * PM chọn một Phase và thấy ngay ma trận Function × loại task: function nào đang
 * trễ, trễ ở khâu nào.
 */
export function SignboardScreen() {
  const [params, setParams] = useSearchParams();
  const epicKey = params.get('epic');
  const phaseCode = params.get('phase');

  if (epicKey === null || epicKey === '') {
    return (
      <EpicPicker
        icon="🗂️"
        title="Pick an Epic for the Signboard"
        description="Choose an active Epic below to build its Signboard."
        onSelect={(key) => setParams({ epic: key })}
      />
    );
  }

  // Chọn Phase = ghi vào URL. Nhờ vậy chia sẻ link giữ nguyên Phase, và bấm một
  // Phase khác trên thanh chọn là CHUYỂN được ngay — không phải tải lại trang.
  const pickPhase = (code: string): void => setParams({ epic: epicKey, phase: code });

  return (
    <div className="stack">
      <div className="scope">
        <span className="scope__label">Epic:</span>
        <code>{epicKey}</code>
        {/* Về lại bộ chọn Epic — xoá cả Epic lẫn Phase khỏi URL. Không có nút này
            thì đổi Epic phải sửa URL tay. */}
        <button type="button" className="button" onClick={() => setParams({})}>
          Change Epic
        </button>
      </div>

      {/* Thanh chọn Phase LUÔN hiện khi đã có Epic — kể cả lúc đang xem một
          Phase — nên người dùng nhảy từ Testing sang Coding chỉ bằng một cú bấm. */}
      <PhaseNav epicKey={epicKey} current={phaseCode} onPick={pickPhase} />

      {phaseCode === null || phaseCode === '' ? (
        <EmptyState
          icon="🧭"
          title="Pick a Phase"
          description="Choose one of the Phases above to build its Signboard."
        />
      ) : (
        // `key` theo Phase: đổi Phase thì bảng dựng lại sạch — ô tìm kiếm và bộ
        // lọc trạng thái của Phase cũ không dính sang Phase mới.
        <SignboardBoard key={phaseCode} epicKey={epicKey} phaseCode={phaseCode} />
      )}
    </div>
  );
}

/**
 * Thanh chọn Phase — thay cho ô gõ tay mã Phase trước đây.
 *
 * Chỉ liệt kê Phase CÓ Sub-task (API đã lọc sẵn), nên PM không phải nhớ mã và
 * không mở nhầm Phase rỗng. Phase đang xem được tô đậm để biết mình ở đâu.
 */
function PhaseNav({
  epicKey,
  current,
  onPick,
}: {
  readonly epicKey: string;
  readonly current: string | null;
  readonly onPick: (code: string) => void;
}) {
  const query = useSignboardPhases(epicKey);

  if (query.isPending) return <LoadingState label="Finding Phases with sub-tasks…" rows={1} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load the Phase list"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const phases = query.data.phases;
  const codes = phases.map((p) => p.phaseCode);
  // Phase đang xem mà KHÔNG còn trong danh sách (Sub-task vừa bị gỡ hết, hoặc mã
  // cũ trên URL) vẫn phải hiện — nếu không người dùng kẹt lại đó, không có nút
  // nào để chuyển đi.
  const orphan = current !== null && current !== '' && !codes.includes(current) ? current : null;

  if (phases.length === 0 && orphan === null) {
    return (
      <div className="notice notice--error" role="status">
        No sub-task in this Epic has a Phase yet. Sync the Epic on the Epics screen, then reload.
      </div>
    );
  }

  return (
    <div className="scope" role="group" aria-label="Select a Phase">
      <span className="scope__label">Phase:</span>
      {phases.map((p) => {
        const active = p.phaseCode === current;
        return (
          <button
            key={p.phaseCode}
            type="button"
            className={`button${active ? ' button--primary' : ''}`}
            aria-pressed={active}
            title={p.label === null ? p.phaseCode : `${p.label} (${p.phaseCode})`}
            onClick={() => onPick(p.phaseCode)}
          >
            {p.label ?? p.phaseCode} <Badge tone="muted">{p.subtaskCount}</Badge>
          </button>
        );
      })}
      {orphan !== null && (
        <button
          type="button"
          className="button button--primary"
          aria-pressed={true}
          title="This Phase has no sub-tasks right now"
          onClick={() => onPick(orphan)}
        >
          {orphan}
        </button>
      )}
    </div>
  );
}

/**
 * Bảng của MỘT Phase đã chọn — tách riêng để mọi hook của bảng nằm gọn một chỗ
 * và chỉ chạy khi thật sự có Phase.
 */
function SignboardBoard({ epicKey, phaseCode }: { readonly epicKey: string; readonly phaseCode: string }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<SignboardStatus | null>(null);

  const board = useSignboard(epicKey, phaseCode);
  const unparsed = useUnparsedSubtasks(epicKey, phaseCode);
  // Vi phạm plan-ngày nghỉ (T-37). Tải song song và KHÔNG chặn bảng: Signboard
  // vẫn dựng đầy đủ kể cả khi API kiểm tra lỗi — ⚠ chỉ là lớp cảnh báo thêm.
  const conflictQuery = usePlanConflicts(epicKey);

  if (board.isPending) return <LoadingState label="Building the Signboard…" rows={5} />;
  if (board.isError) {
    return (
      <ErrorState error={board.error} title="Could not build the board" onRetry={() => void board.refetch()} />
    );
  }

  const data = board.data;
  // Chỉ giữ vi phạm của PHASE đang xem — bảng này là bảng của một Phase, đếm
  // cả Epic sẽ lệch với những gì nhìn thấy trên lưới.
  const phaseConflicts = (conflictQuery.data?.conflicts ?? []).filter(
    (c) => c.phaseCode === phaseCode,
  );
  const conflictsByIssue = new Map(phaseConflicts.map((c) => [c.issueKey, c]));

  return (
    <div className="stack">
      <div className="scope">
        {/* Trạng thái phụ thuộc "hôm nay". Người dùng mở tab từ hôm qua rồi quay
            lại sẽ thấy trạng thái cũ, nên NGÀY ĐANG TÍNH phải hiện rõ. */}
        <span className="muted">Status as of {data.asOfDate}</span>
        <button
          type="button"
          className="button"
          title="Refresh the data and clear any status filter or search"
          onClick={() => {
            // "Reload" = quay lại khung nhìn ĐẦY ĐỦ với dữ liệu mới nhất. Người
            // dùng lọc "task trễ" xong bấm Reload là để xem lại TOÀN BỘ bảng, nên
            // phải xoá bộ lọc trạng thái và ô tìm kiếm TRƯỚC khi tải lại — giữ
            // nguyên bộ lọc thì họ kẹt trong khung đã lọc, không có đường ra rõ.
            setFilter(null);
            setSearch('');
            void board.refetch();
          }}
        >
          Reload
        </button>
      </div>

      {data.parseHealthWarning && (
        <div className="notice notice--error" role="alert">
          More than 30% of this Phase&rsquo;s sub-tasks have titles in the wrong format, so the board
          is missing data. They <strong>still count towards the Burndown chart</strong>; see
          &ldquo;Not on the board&rdquo; below to find out which ones to fix.
        </div>
      )}

      {phaseConflicts.length > 0 && (
        <div className="notice notice--error" role="alert">
          <strong>{phaseConflicts.length}</strong> sub-task
          {phaseConflicts.length === 1 ? ' in this Phase has' : 's in this Phase have'} a planned
          start or end date on a day off — cells below are flagged with{' '}
          <Badge tone="danger">⚠ day off</Badge>; hover a flagged cell for the reason. Fix the wbs
          dates in Jira, then resync.{' '}
          <Link className="button" to={`/phase-subtasks?epic=${epicKey}`}>
            See the full list
          </Link>
        </div>
      )}

      <SummaryBar summary={data.summary} filter={filter} onFilter={setFilter} />

      <div className="scope">
        <input
          className="input input--wide"
          value={search}
          placeholder="Search Functions…"
          aria-label="Search Functions"
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Chỗ chỉnh thứ tự Sub-phase là khu ⑤ ở màn Signboard columns; link dưới
          mở thẳng sang đó KÈM Phase này và các Sub-phase đang có trên bảng để
          điền sẵn — PM chỉ việc bấm mũi tên xếp lại rồi Lưu. Chỉ hiện khi ≥ 2
          nhóm: một nhóm thì thứ tự vô nghĩa, hint chỉ gây nhiễu. */}
      {data.columnGroups.length > 1 && (
        <p className="muted">
          <Link to={subPhaseOrderLink(phaseCode, data.columnGroups)}>Set sub-phase order</Link> —
          opens Signboard settings with this Phase&rsquo;s sub-phases pre-filled. Sub-phases not
          declared there fall back to: match a Phase&rsquo;s code → that Phase&rsquo;s position,
          otherwise A→Z, with &ldquo;(No sub-phase)&rdquo; always last.
        </p>
      )}

      <BoardTable
        rows={data.rows}
        columnGroups={data.columnGroups}
        search={search}
        filter={filter}
        conflicts={conflictsByIssue}
      />

      <UnparsedPanel query={unparsed} />
    </div>
  );
}

function SummaryBar({
  summary,
  filter,
  onFilter,
}: {
  readonly summary: { readonly byStatus: Readonly<Record<string, number>>; readonly emptyCells: number };
  readonly filter: SignboardStatus | null;
  readonly onFilter: (next: SignboardStatus | null) => void;
}) {
  return (
    <div className="scope" role="group" aria-label="Status summary">
      {SIGNBOARD_STATUS.map((status) => {
        const count = summary.byStatus[status] ?? 0;
        if (count === 0) return null;
        const active = filter === status;
        return (
          <button
            key={status}
            type="button"
            className={`button${active ? ' button--primary' : ''}`}
            aria-pressed={active}
            // Bấm lần nữa thì bỏ lọc — không có đường thoát thì người dùng phải
            // tải lại trang.
            onClick={() => onFilter(active ? null : status)}
          >
            {/* Chip số đếm dùng CHUNG màu nền với ô của bảng (data-status) để
                thanh tóm tắt là chú giải khớp đúng: Done đen, đúng tiến độ xanh
                dương, trễ đỏ, chưa bắt đầu xám, chưa có ngày tím. */}
            <span className="signboard__count" data-status={status}>
              {count}
            </span>{' '}
            {STATUS_LABEL[status]}
          </button>
        );
      })}
      {/* Ô "không có task" đã tô XÁM trên bảng → ghi vào chú giải luôn, cùng đúng
          màu xám đó, để thanh tóm tắt phản ánh đầy đủ những gì thấy trên bảng. */}
      <span className="signboard__legend-empty">
        <span className="signboard__count signboard__count--empty">{summary.emptyCells}</span> No
        task <span className="muted">(empty · not counted)</span>
      </span>
      {filter !== null && (
        <span className="notice notice--ok" role="status">
          Filtering by <strong>{STATUS_LABEL[filter]}</strong> — other cells are dimmed, not removed.
        </span>
      )}
    </div>
  );
}

/**
 * Link mở khu "⑤ Sub-phase order" ở màn Signboard columns, điền sẵn Phase đang
 * xem + các Sub-phase đang có trên bảng.
 *
 * Gửi `subPhaseKey` (đã chuẩn hoá) chứ KHÔNG gửi nhãn: nhãn có thể là tên đẹp
 * của Phase trùng mã (ví dụ "Test Case") — lưu nhãn đó làm mã thì không khớp
 * lại được với `[Sub-phase]` thô trong tiêu đề. Nhóm "(No sub-phase)" (khoá
 * rỗng) không gửi — nó luôn đứng cuối, không xếp được.
 */
function subPhaseOrderLink(
  phaseCode: string,
  groups: readonly SignboardColumnGroup[],
): string {
  const subs = groups.map((g) => g.subPhaseKey).filter((k) => k !== '');
  const params = new URLSearchParams({ orderPhase: phaseCode, subs: subs.join(',') });
  return `/config/signboard?${params.toString()}`;
}

/**
 * Các trạng thái được TÔ NỀN cả ô (PRD §6.3, §6.7): Done → đen, On schedule →
 * xanh dương, Late start/finish → đỏ. `NYS` cố ý KHÔNG tô (task chưa bắt đầu),
 * `NO_PLAN` giữ kẻ sọc riêng. Màu chỉ để lướt cho nhanh — chữ + badge vẫn còn.
 */
const TINTED_STATUS: ReadonlySet<SignboardStatus> = new Set([
  'COMPLETED',
  'ON_SCHEDULE',
  'DELAY_START',
  'DELAY_END',
]);

/**
 * Trạng thái để tô nền `<td>`, hoặc `undefined` khi ô không được tô.
 *
 * Đặt trên `<td>` (không phải `<span>` bên trong) để màu phủ HẾT ô. Khi đang lọc,
 * ô không khớp bị làm mờ thành `·` nên cũng không tô — thành ra lọc lại nổi bật
 * đúng những ô đang quan tâm.
 */
function tdStatus(
  cell: SignboardCell | undefined,
  filter: SignboardStatus | null,
): SignboardStatus | undefined {
  if (cell === undefined || !cell.present) return undefined;
  if (filter !== null && cell.status !== filter) return undefined;
  return TINTED_STATUS.has(cell.status) ? cell.status : undefined;
}

function BoardTable({
  rows,
  columnGroups,
  search,
  filter,
  conflicts,
}: {
  readonly rows: readonly SignboardRow[];
  readonly columnGroups: readonly SignboardColumnGroup[];
  readonly search: string;
  readonly filter: SignboardStatus | null;
  /** Vi phạm plan-ngày nghỉ theo `issueKey`, đã lọc theo Phase đang xem (T-37). */
  readonly conflicts: ReadonlyMap<string, PlanConflict>;
}) {
  // Lọc theo `functionKey` ĐÃ CHUẨN HOÁ để gõ `login` cũng tìm ra `Ｌｏｇｉｎ`.
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return rows;
    return rows.filter(
      (r) => r.functionKey.includes(needle) || r.functionName.toLowerCase().includes(needle),
    );
  }, [rows, search]);

  // Vị trí ô LÁ đầu tiên của mỗi nhóm trong `row.cells` (đã làm phẳng). Tính sẵn
  // một lần thay vì cộng dồn trong vòng lặp render.
  const groupOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const g of columnGroups) {
      offsets.push(acc);
      acc += g.taskColumns.length;
    }
    return offsets;
  }, [columnGroups]);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No Function made it onto the board"
        description="No sub-task in this Phase has a correctly formatted title. See the section below."
      />
    );
  }

  // Cột Σ (gộp mỗi Sub-phase) CHỈ có nghĩa khi có ≥2 Sub-phase để so với nhau.
  // Một Sub-phase thì Σ của nó TRÙNG KHÍT cột "Overall" (cùng đúng bộ ticket) —
  // hiện cả hai là in "total" hai lần. Bỏ Σ, giữ "Overall" cho rõ nghĩa.
  const showSubtotals = columnGroups.length > 1;

  return (
    <section className="panel">
      <div className="table-wrap">
        <table className="table signboard">
          <caption className="table__caption">Function × sub-phase × task type grid</caption>
          <thead>
            {/* Tầng 1: nhóm Sub-phase. Mỗi nhóm trải trên bộ cột loại task, cộng
                cột Σ khi có ≥2 nhóm (một nhóm thì Σ trùng Overall — xem trên). */}
            <tr>
              {/* Cột Function DÍNH bên trái: bảng rất rộng, cuộn sang phải mà
                  mất tên hàng thì mọi ô trở nên vô nghĩa. */}
              <th
                scope="col"
                rowSpan={2}
                className="table__th signboard__sticky"
              >
                Function
              </th>
              {columnGroups.map((g) => (
                <th
                  key={g.subPhaseKey}
                  scope="colgroup"
                  colSpan={g.taskColumns.length + (showSubtotals ? 1 : 0)}
                  className="table__th signboard__group"
                >
                  {g.subPhaseLabel}
                </th>
              ))}
              <th scope="col" rowSpan={2} className="table__th">
                Overall
              </th>
            </tr>
            {/* Tầng 2: loại task trong từng nhóm, cộng một cột Σ khép nhóm (chỉ
                khi ≥2 nhóm). */}
            <tr>
              {columnGroups.map((g) => (
                <Fragment key={g.subPhaseKey}>
                  {g.taskColumns.map((c) => (
                    <th key={`${g.subPhaseKey}:${c.taskCode}`} scope="col" className="table__th">
                      {c.label}
                    </th>
                  ))}
                  {showSubtotals && (
                    <th
                      scope="col"
                      className="table__th signboard__subtotal-head"
                      title={`Worst status across ${g.subPhaseLabel}`}
                    >
                      Σ
                    </th>
                  )}
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.functionKey}>
                <th scope="row" className="table__td signboard__sticky">
                  {row.functionName}
                </th>
                {columnGroups.map((g, gi) => (
                  <Fragment key={g.subPhaseKey}>
                    {g.taskColumns.map((c, ci) => {
                      const cell = row.cells[groupOffsets[gi]! + ci];
                      // Ô TRỐNG (Function không có khâu đó) tô nền xám cả ô để lùi
                      // ra sau — khác hẳn `NO_PLAN` (có việc, thiếu ngày) vẫn nổi.
                      const empty = cell === undefined || !cell.present;
                      return (
                        <td
                          key={`${g.subPhaseKey}:${c.taskCode}`}
                          className={`table__td${empty ? ' signboard__empty' : ''}`}
                          data-status={tdStatus(cell, filter)}
                        >
                          {/* ⚠ và hovercard "mở/copy ticket" chỉ gắn ở ô LÁ. Ô Σ
                              và Overall gộp nhiều loại task — lặp lại ở đó chỉ
                              thêm nhiễu. */}
                          {cell !== undefined && (
                            <SignboardCellView
                              cell={cell}
                              filter={filter}
                              conflicts={conflicts}
                              interactive
                              jiraBaseUrl={JIRA_BASE}
                            />
                          )}
                        </td>
                      );
                    })}
                    {showSubtotals && (
                      <td className="table__td signboard__subtotal" data-status={tdStatus(row.subtotals[gi], null)}>
                        {row.subtotals[gi] !== undefined && (
                          <SignboardCellView cell={row.subtotals[gi]!} filter={null} />
                        )}
                      </td>
                    )}
                  </Fragment>
                ))}
                <td className="table__td" data-status={tdStatus(row.total, null)}>
                  <SignboardCellView cell={row.total} filter={null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown.length === 0 && <p className="muted">No Function matches that search.</p>}
    </section>
  );
}

function UnparsedPanel({ query }: { readonly query: ReturnType<typeof useUnparsedSubtasks> }) {
  if (query.isPending) return <LoadingState label="Looking for sub-tasks not on the board…" rows={2} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const data = query.data;
  if (data.items.length === 0) {
    return (
      <EmptyState
        icon="✅"
        title="Every sub-task made it onto the board"
        description="No title is in the wrong format and no unknown task type was found."
      />
    );
  }

  return (
    <section className="panel" aria-labelledby="unparsed-title">
      <h2 className="panel__title" id="unparsed-title">
        Not on the board ({data.items.length})
      </h2>
      <p className="panel__hint">
        These sub-tasks <strong>still count towards the Burndown chart</strong>. They just do not fit
        into any cell on the Signboard.
      </p>

      {data.suggestedColumns.length > 0 && (
        <div className="notice notice--ok" role="status">
          Suggested new columns:{' '}
          {data.suggestedColumns.map((s) => (
            <span key={s.taskCode}>
              <code>{s.taskCode}</code> ({s.count}×){' '}
            </span>
          ))}
          <Link className="button" to="/config/signboard">
            Open column settings
          </Link>
        </div>
      )}

      <ul className="rows">
        {data.items.map((item) => (
          <li className="row" key={item.issueKey}>
            <code>{item.issueKey}</code>
            <span>{item.summary}</span>
            <Badge tone={item.reason === 'BAD_TITLE_FORMAT' ? 'danger' : 'warning'}>
              {item.reason === 'BAD_TITLE_FORMAT' ? 'title format is wrong' : 'unknown task type'}
            </Badge>
            <span className="muted">{item.hint}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
