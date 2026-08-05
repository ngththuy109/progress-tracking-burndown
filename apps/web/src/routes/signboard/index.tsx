import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SIGNBOARD_STATUS, type SignboardRow, type SignboardStatus } from '@app/shared';
import { useSignboard, useUnparsedSubtasks } from '../../api/use-signboard.js';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/ui/index.js';
import { SignboardCellView, STATUS_LABEL, STATUS_TONE } from './signboard-cell.js';

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

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<SignboardStatus | null>(null);

  const board = useSignboard(epicKey, phaseCode);
  const unparsed = useUnparsedSubtasks(epicKey, phaseCode);

  if (epicKey === null || epicKey === '') {
    return (
      <EmptyState
        icon="🗂️"
        title="No Epic selected"
        description="Open the Epics screen and click Signboard on the Epic you want to see."
      />
    );
  }

  if (phaseCode === null || phaseCode === '') {
    return (
      <div className="stack">
        <PhaseInput epicKey={epicKey} onPick={(code) => setParams({ epic: epicKey, phase: code })} />
        <EmptyState title="No Phase selected" description="Enter a Phase code, for example DESIGN." />
      </div>
    );
  }

  if (board.isPending) return <LoadingState label="Building the Signboard…" rows={5} />;
  if (board.isError) {
    return (
      <ErrorState error={board.error} title="Could not build the board" onRetry={() => void board.refetch()} />
    );
  }

  const data = board.data;

  return (
    <div className="stack">
      <div className="scope">
        <span className="scope__label">Epic:</span>
        <code>{epicKey}</code>
        <span className="scope__label">Phase:</span>
        <code>{phaseCode}</code>
        {/* Trạng thái phụ thuộc "hôm nay". Người dùng mở tab từ hôm qua rồi quay
            lại sẽ thấy trạng thái cũ, nên NGÀY ĐANG TÍNH phải hiện rõ. */}
        <span className="muted">Status as of {data.asOfDate}</span>
        <button type="button" className="button" onClick={() => void board.refetch()}>
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

      <BoardTable rows={data.rows} columns={data.columns} search={search} filter={filter} />

      <UnparsedPanel query={unparsed} />
    </div>
  );
}

function PhaseInput({ epicKey, onPick }: { readonly epicKey: string; readonly onPick: (code: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="scope">
      <span className="scope__label">Epic {epicKey} · Phase:</span>
      <input
        className="input input--code"
        value={text}
        aria-label="Phase code"
        onChange={(e) => setText(e.target.value)}
      />
      <button type="button" className="button button--primary" disabled={text.trim() === ''} onClick={() => onPick(text.trim())}>
        Open board
      </button>
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
            <Badge tone={STATUS_TONE[status]}>{count}</Badge> {STATUS_LABEL[status]}
          </button>
        );
      })}
      <span className="muted">{summary.emptyCells} empty cells (not counted)</span>
      {filter !== null && (
        <span className="notice notice--ok" role="status">
          Filtering by <strong>{STATUS_LABEL[filter]}</strong> — other cells are dimmed, not removed.
        </span>
      )}
    </div>
  );
}

function BoardTable({
  rows,
  columns,
  search,
  filter,
}: {
  readonly rows: readonly SignboardRow[];
  readonly columns: readonly { readonly taskCode: string; readonly label: string }[];
  readonly search: string;
  readonly filter: SignboardStatus | null;
}) {
  // Lọc theo `functionKey` ĐÃ CHUẨN HOÁ để gõ `login` cũng tìm ra `Ｌｏｇｉｎ`.
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return rows;
    return rows.filter(
      (r) => r.functionKey.includes(needle) || r.functionName.toLowerCase().includes(needle),
    );
  }, [rows, search]);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No Function made it onto the board"
        description="No sub-task in this Phase has a correctly formatted title. See the section below."
      />
    );
  }

  return (
    <section className="panel">
      <div className="table-wrap">
        <table className="table signboard">
          <caption className="table__caption">Function × task type grid</caption>
          <thead>
            <tr>
              {/* Cột Function DÍNH bên trái: bảng rất rộng, cuộn sang phải mà
                  mất tên hàng thì mọi ô trở nên vô nghĩa. */}
              <th scope="col" className="table__th signboard__sticky">
                Function
              </th>
              {columns.map((c) => (
                <th key={c.taskCode} scope="col" className="table__th">
                  {c.label}
                </th>
              ))}
              <th scope="col" className="table__th">
                Overall
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.functionKey}>
                <th scope="row" className="table__td signboard__sticky">
                  {row.functionName}
                </th>
                {row.cells.map((cell, i) => (
                  <td key={columns[i]?.taskCode ?? i} className="table__td">
                    <SignboardCellView cell={cell} filter={filter} />
                  </td>
                ))}
                <td className="table__td">
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
