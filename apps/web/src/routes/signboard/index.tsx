import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  SIGNBOARD_STATUS,
  type SignboardCell,
  type SignboardColumnGroup,
  type SignboardPic,
  type SignboardRow,
  type SignboardStatus,
} from '@app/shared';
import { useSignboard, useSignboardPhases, useUnparsedSubtasks } from '../../api/use-signboard.js';
import { usePlanConflicts } from '../../api/use-plan-conflicts.js';
import { EpicPicker } from '../../components/epic-picker/index.js';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/ui/index.js';
import { SignboardCellView, STATUS_LABEL } from './signboard-cell.js';
import { IssueLink } from '../../components/issue-link/index.js';
import { jiraBaseUrl } from '../../api/jira.js';
import type { PlanConflict } from '@app/shared';

/**
 * Base URL Jira cho các link "mở ticket" trong ô. Đọc MỘT lần (biến Vite tĩnh);
 * `''` = chưa cấu hình → ô chỉ cho copy mã, không mở thẳng sang Jira.
 */
const JIRA_BASE = jiraBaseUrl();

/**
 * Token URL cho “toàn bộ Epic”: `?phases=__all__`. Lưu token thay vì liệt kê mã
 * để lựa chọn luôn bám theo DANH SÁCH Phase hiện tại — Epic thêm/bớt Phase thì
 * “toàn bộ” vẫn đúng mà không phải sửa link.
 */
const ALL_TOKEN = '__all__';

/**
 * Bảng Signboard — PRD §6.
 *
 * PM chọn MỘT hay NHIỀU Phase (hoặc “toàn bộ Epic”) và thấy ngay ma trận
 * Function × loại task của từng Phase: function nào đang trễ, trễ ở khâu nào.
 * Chọn nhiều Phase thì mỗi Phase là một bảng riêng, xếp chồng theo thứ tự cấu
 * hình — mỗi bảng giữ nguyên thanh tóm tắt, cột Sub-phase và khu “chưa lên
 * bảng” của chính nó, KHÔNG trộn số liệu giữa các Phase.
 */
export function SignboardScreen() {
  const [params, setParams] = useSearchParams();
  const epicKey = params.get('epic');
  // Nhóm tầng-1 đang lọc (VD Giai đoạn GD1/GD2) — trong URL để link chia sẻ giữ
  // nguyên khung nhìn. `null` = tất cả; Epic không có tầng nhóm thì bộ lọc tự ẩn.
  const stage = params.get('stage');

  // Danh sách Phase có Sub-task — vừa là nguồn cho bộ chọn, vừa để giãn token
  // “toàn bộ Epic” (__all__) ra đúng những Phase đang có dữ liệu, và lấy nhãn
  // tiêu đề cho mỗi bảng. Gọi Ở ĐÂY (không nằm trong PhaseNav) để mọi phần dùng
  // CHUNG một nguồn. `enabled` theo epicKey nên gọi vô điều kiện vẫn an toàn.
  // Phase + số đếm theo `stage` đang lọc — đổi nhóm là danh sách đếm lại.
  const phasesQuery = useSignboardPhases(epicKey, stage);

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

  const allCodes = (phasesQuery.data?.phases ?? []).map((p) => p.phaseCode);
  const rawPhases = params.get('phases');
  // `phases` (danh sách hoặc token __all__) là nguồn chính; `phase` cũ (một mã)
  // vẫn đọc được để link chia sẻ từ trước không gãy.
  const selection = resolveSelection(rawPhases, params.get('phase'), allCodes);

  // Chọn Phase = ghi vào URL, nên chia sẻ link giữ nguyên lựa chọn và bấm là
  // đổi ngay, không tải lại trang. Chọn HẾT thì rút gọn về __all__ cho URL gọn
  // và để nút “Whole epic” sáng lên. LUÔN giữ `stage` đang lọc.
  const writeSelection = (codes: readonly string[]): void => {
    const keepStage = stage === null ? {} : { stage };
    const ordered = orderByList(codes, allCodes);
    if (ordered.length === 0) {
      setParams({ epic: epicKey, ...keepStage });
      return;
    }
    const isAll =
      allCodes.length > 0 &&
      ordered.length === allCodes.length &&
      allCodes.every((c) => ordered.includes(c));
    setParams({ epic: epicKey, phases: isAll ? ALL_TOKEN : ordered.join(','), ...keepStage });
  };

  // Đổi nhóm tầng-1: giữ nguyên lựa chọn Phase (mã Phase thường có ở cả hai nhóm;
  // mã không còn dữ liệu trong nhóm mới sẽ hiện thành nút "mồ côi" để bỏ chọn).
  const writeStage = (next: string | null): void => {
    const keepPhases = rawPhases === null || rawPhases === '' ? {} : { phases: rawPhases };
    setParams({ epic: epicKey, ...keepPhases, ...(next === null ? {} : { stage: next }) });
  };

  const togglePhase = (code: string): void => {
    const next = new Set(selection.codes);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    writeSelection([...next]);
  };

  const toggleWholeEpic = (): void => writeSelection(selection.wholeEpic ? [] : allCodes);

  const labelOf = (code: string): string =>
    phasesQuery.data?.phases.find((p) => p.phaseCode === code)?.label ?? code;

  return (
    <div className="stack">
      <div className="scope">
        <span className="scope__label">Epic:</span>
        <IssueLink issueKey={epicKey} />
        {/* Về lại bộ chọn Epic — xoá cả Epic lẫn lựa chọn Phase khỏi URL. */}
        <button type="button" className="button" onClick={() => setParams({})}>
          Change Epic
        </button>
      </div>

      {/* Bộ lọc nhóm tầng-1 (VD Giai đoạn) — CHỈ hiện khi Epic có ≥ 2 nhóm. Epic
          một giai đoạn / một tầng không thấy gì khác so với trước. */}
      <StageNav
        tierLabel={phasesQuery.data?.stageTierLabel ?? null}
        stages={phasesQuery.data?.stages ?? []}
        selected={stage}
        onSelect={writeStage}
      />

      {/* Thanh chọn Phase LUÔN hiện khi đã có Epic — chọn được nhiều Phase một
          lúc, hoặc “Whole epic” để mở tất cả chỉ bằng một cú bấm. */}
      <PhaseNav
        query={phasesQuery}
        selectedCodes={selection.codes}
        wholeEpic={selection.wholeEpic}
        onToggle={togglePhase}
        onToggleWholeEpic={toggleWholeEpic}
      />

      {selection.codes.length === 0 ? (
        rawPhases === ALL_TOKEN && phasesQuery.isPending ? (
          <LoadingState label="Loading this Epic's Phases…" rows={3} />
        ) : (
          <EmptyState
            icon="🧭"
            title="Pick one or more Phases"
            description="Choose Phases above — or “Whole epic” — to build the Signboard."
          />
        )
      ) : selection.codes.length === 1 ? (
        // Một Phase: dựng bảng trực tiếp, không thêm tiêu đề (giữ nguyên khung
        // nhìn quen thuộc). `key` theo Phase + nhóm để đổi là dựng lại sạch — ô
        // tìm kiếm và bộ lọc của khung nhìn cũ không dính sang khung nhìn mới.
        <SignboardBoard
          key={`${selection.codes[0]}·${stage ?? ''}`}
          epicKey={epicKey}
          phaseCode={selection.codes[0]!}
          stage={stage}
        />
      ) : (
        // Nhiều Phase: mỗi Phase một bảng riêng, có tiêu đề để biết đang xem
        // bảng nào. `key` theo mã Phase nên thêm/bớt một Phase KHÔNG dựng lại
        // các bảng còn lại (giữ nguyên tìm kiếm/bộ lọc của chúng).
        selection.codes.map((code) => (
          <section key={code} className="stack signboard-phase" aria-label={`Phase ${labelOf(code)}`}>
            <h2 className="signboard-phase__title">
              {labelOf(code)} <Badge tone="muted">{code}</Badge>
            </h2>
            <SignboardBoard key={`${code}·${stage ?? ''}`} epicKey={epicKey} phaseCode={code} stage={stage} />
          </section>
        ))
      )}
    </div>
  );
}

/** Lựa chọn Phase đã giải mã từ URL. */
interface PhaseSelection {
  /** Mã Phase cần dựng bảng, đã sắp theo display_order và rút trùng. */
  readonly codes: string[];
  /** `true` khi đang xem “toàn bộ Epic” (mọi Phase được chọn). */
  readonly wholeEpic: boolean;
}

/**
 * Giải mã lựa chọn Phase từ URL.
 *
 * `phases=__all__` → toàn bộ Epic (giãn ra mọi Phase đang có Sub-task).
 * `phases=A,B`     → đúng các Phase đó (rút trùng, sắp theo display_order).
 * `phase=A` (cũ)   → một Phase — vẫn đọc để link chia sẻ từ trước không gãy.
 * Chọn trùng khít toàn bộ danh sách cũng coi là “toàn bộ Epic” để nút sáng lên.
 */
function resolveSelection(
  rawPhases: string | null,
  legacyPhase: string | null,
  allCodes: readonly string[],
): PhaseSelection {
  if (rawPhases === ALL_TOKEN) return { codes: [...allCodes], wholeEpic: true };
  if (rawPhases !== null && rawPhases !== '') {
    const codes = orderByList(
      rawPhases.split(',').map((s) => s.trim()).filter((s) => s !== ''),
      allCodes,
    );
    const wholeEpic =
      allCodes.length > 0 && codes.length === allCodes.length && allCodes.every((c) => codes.includes(c));
    return { codes, wholeEpic };
  }
  if (legacyPhase !== null && legacyPhase !== '') return { codes: [legacyPhase], wholeEpic: false };
  return { codes: [], wholeEpic: false };
}

/**
 * Sắp mã Phase theo thứ tự danh sách (display_order của cấu hình) và rút trùng.
 * Mã “lạ” (không có trong danh sách — link cũ, hoặc Sub-task vừa gỡ hết) vẫn
 * giữ lại, xếp CUỐI theo thứ tự gặp, để không im lặng đánh rơi lựa chọn.
 */
function orderByList(codes: readonly string[], allCodes: readonly string[]): string[] {
  const wanted = new Set(codes);
  const known = allCodes.filter((c) => wanted.has(c));
  const knownSet = new Set(allCodes);
  const extras: string[] = [];
  for (const c of codes) if (!knownSet.has(c) && !extras.includes(c)) extras.push(c);
  return [...known, ...extras];
}

/**
 * Bộ lọc nhóm TẦNG TRÊN CÙNG (VD "Giai đoạn" GD1/GD2) — đứng TRƯỚC bộ chọn Phase.
 *
 * Chỉ hiện khi Epic có ≥ 2 nhóm: Epic một giai đoạn (mọi lá cùng nhóm catch-all)
 * hay Epic 1 tầng không thấy gì khác so với trước. Nhãn thanh lấy từ chính tên
 * tầng PM đã đặt ở màn Cấu trúc tầng (VD "Giai đoạn"), không viết cứng.
 */
function StageNav({
  tierLabel,
  stages,
  selected,
  onSelect,
}: {
  readonly tierLabel: string | null;
  readonly stages: readonly { code: string; label: string | null; subtaskCount: number }[];
  readonly selected: string | null;
  readonly onSelect: (stage: string | null) => void;
}) {
  if (stages.length < 2) return null;

  return (
    <div className="scope" role="group" aria-label={`Filter by ${tierLabel ?? 'group'}`}>
      <span className="scope__label">{tierLabel ?? 'Group'}:</span>
      <button
        type="button"
        className={`button${selected === null ? ' button--primary' : ''}`}
        aria-pressed={selected === null}
        title="Show every group"
        onClick={() => onSelect(null)}
      >
        All
      </button>
      {stages.map((s) => (
        <button
          key={s.code}
          type="button"
          className={`button${selected === s.code ? ' button--primary' : ''}`}
          aria-pressed={selected === s.code}
          title={s.label === null ? s.code : `${s.label} (${s.code})`}
          onClick={() => onSelect(s.code)}
        >
          {s.label ?? s.code} <Badge tone="muted">{s.subtaskCount}</Badge>
        </button>
      ))}
    </div>
  );
}

/**
 * Thanh chọn Phase — cho chọn NHIỀU Phase và có nút “Whole epic”.
 *
 * Chỉ liệt kê Phase CÓ Sub-task (API đã lọc sẵn), nên PM không phải nhớ mã và
 * không mở nhầm Phase rỗng. Phase đang chọn được tô đậm; “Whole epic” sáng lên
 * khi mọi Phase đang được chọn. Nhận danh sách qua `query` (màn hình đã tải sẵn)
 * để không gọi API trùng.
 */
function PhaseNav({
  query,
  selectedCodes,
  wholeEpic,
  onToggle,
  onToggleWholeEpic,
}: {
  readonly query: ReturnType<typeof useSignboardPhases>;
  readonly selectedCodes: readonly string[];
  readonly wholeEpic: boolean;
  readonly onToggle: (code: string) => void;
  readonly onToggleWholeEpic: () => void;
}) {
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
  // Mã đang chọn nhưng KHÔNG còn trong danh sách (Sub-task vừa bị gỡ hết, hoặc
  // link cũ) vẫn phải hiện — nếu không người dùng không có nút nào để BỎ chọn nó.
  const orphans = selectedCodes.filter((c) => !codes.includes(c));

  if (phases.length === 0 && orphans.length === 0) {
    return (
      <div className="notice notice--error" role="status">
        No sub-task in this Epic has a Phase yet. Sync the Epic on the Epics screen, then reload.
      </div>
    );
  }

  return (
    <div className="scope" role="group" aria-label="Select Phases">
      <span className="scope__label">Phases:</span>
      {/* “Whole epic” = chọn hết mọi Phase đang có Sub-task; bấm lần nữa để bỏ. */}
      <button
        type="button"
        className={`button${wholeEpic ? ' button--primary' : ''}`}
        aria-pressed={wholeEpic}
        title="Show every Phase that has sub-tasks"
        onClick={onToggleWholeEpic}
      >
        Whole epic
      </button>
      {phases.map((p) => {
        // Đang xem “toàn bộ Epic” thì coi như MỌI Phase đều được chọn.
        const active = wholeEpic || selectedCodes.includes(p.phaseCode);
        return (
          <button
            key={p.phaseCode}
            type="button"
            className={`button${active ? ' button--primary' : ''}`}
            aria-pressed={active}
            title={p.label === null ? p.phaseCode : `${p.label} (${p.phaseCode})`}
            onClick={() => onToggle(p.phaseCode)}
          >
            {p.label ?? p.phaseCode} <Badge tone="muted">{p.subtaskCount}</Badge>
          </button>
        );
      })}
      {orphans.map((code) => (
        <button
          key={code}
          type="button"
          className="button button--primary"
          aria-pressed={true}
          title="This Phase has no sub-tasks right now"
          onClick={() => onToggle(code)}
        >
          {code}
        </button>
      ))}
    </div>
  );
}

/**
 * Bảng của MỘT Phase đã chọn — tách riêng để mọi hook của bảng nằm gọn một chỗ
 * và chỉ chạy khi thật sự có Phase.
 */
function SignboardBoard({
  epicKey,
  phaseCode,
  stage = null,
}: {
  readonly epicKey: string;
  readonly phaseCode: string;
  readonly stage?: string | null;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<SignboardStatus | null>(null);

  const board = useSignboard(epicKey, phaseCode, stage);
  const unparsed = useUnparsedSubtasks(epicKey, phaseCode, stage);
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

  // Cột nào không có task nào thì API không dựng cột đó. Hết sạch cột (mọi
  // sub-task mang một loại task chưa khai cột) thì lưới chỉ còn tên Function —
  // nói thẳng ra còn hơn vẽ một cái bảng rỗng.
  if (columnGroups.length === 0) {
    return (
      <EmptyState
        title="No task-type column has any sub-task"
        description="Every configured column is empty for this Phase, so there is no grid to draw. See “Not on the board” below for the sub-tasks that fit no column."
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
              {/* Cột PIC: người phụ trách Function, gom "Request participants" của
                  mọi Sub-task (bỏ trùng). Đứng ngay sau tên Function để đọc theo
                  hàng. */}
              <th scope="col" rowSpan={2} className="table__th signboard__pic-head">
                PIC
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
                <td className="table__td signboard__pic">
                  <PicList pics={row.pics} />
                </td>
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

/**
 * Cột PIC của một Function: danh sách người phụ trách, gom từ "Request
 * participants" của mọi Sub-task (đã bỏ trùng ở API).
 *
 * Hiện tên; người chưa tra được tên hiện accountId để KHÔNG im lặng bỏ sót ai.
 * `title` liệt kê đầy đủ để rê chuột đọc khi ô bị cắt bớt.
 */
function PicList({ pics }: { readonly pics: readonly SignboardPic[] }) {
  if (pics.length === 0) {
    return (
      <span className="cell cell--empty" title="No participants">
        —
      </span>
    );
  }
  const labels = pics.map((p) => p.displayName ?? p.accountId);
  return (
    <span className="signboard__pic-names" title={labels.join(', ')}>
      {labels.join(', ')}
    </span>
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
            <IssueLink issueKey={item.issueKey} />
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
