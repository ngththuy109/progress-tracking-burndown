import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ChartSeries, ExplainRow, TierSeries } from '@app/shared';
import { useBurndown, useExplainDay } from '../../api/use-burndown.js';
import { BurndownChart } from '../../components/chart/burndown-chart.js';
import { EpicPicker } from '../../components/epic-picker/index.js';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  type Column,
} from '../../components/ui/index.js';
import { childrenOf, hasChildren } from './tier-drill.js';

/**
 * Màn hình biểu đồ Burndown — PRD §5.1.
 *
 * HAI CHẾ ĐỘ XEM DÙNG CHUNG MỘT TẬP DỮ LIỆU. Đổi chế độ hay đổi Phase KHÔNG gọi
 * lại API: T-17 đã tính sẵn đường Kế hoạch của từng Phase vào `per_phase` chính
 * vì lý do đó.
 */

/**
 * Chế độ xem của MÀN HÌNH này — chỉ còn tổng Epic và một Phase. Chế độ so sánh
 * nhiều Phase đã gỡ khỏi giao diện; `ChartMode` trong hợp đồng API vẫn còn
 * `COMPARE` nên phần backend không đổi.
 */
type ScreenMode = 'EPIC' | 'PHASE' | 'TIER';

const MODE_LABEL: Record<ScreenMode, string> = {
  EPIC: 'Whole Epic',
  PHASE: 'Single Phase',
  TIER: 'Theo tầng',
};

export function BurndownScreen() {
  const [params, setParams] = useSearchParams();
  const epicKey = params.get('epic');

  const [mode, setMode] = useState<ScreenMode>('EPIC');
  const [selected, setSelected] = useState<string[]>([]);
  const [tierPath, setTierPath] = useState<string[]>([]);
  const [explainDate, setExplainDate] = useState<string | null>(null);

  const query = useBurndown(epicKey);

  if (epicKey === null || epicKey === '') {
    return (
      <EpicPicker
        icon="📉"
        title="Pick an Epic to chart"
        description="Choose an active Epic below to load its burndown chart."
        onSelect={(key) => setParams({ epic: key })}
      />
    );
  }

  if (query.isPending) return <LoadingState label="Loading chart data…" rows={5} />;
  if (query.isError) {
    return (
      <ErrorState error={query.error} title="Could not load the chart" onRetry={() => void query.refetch()} />
    );
  }

  const data = query.data;
  const phaseKeys = [...new Set(data.series.flatMap((s) => (s.key === 'EPIC' ? [] : [s.key])))];
  // Tab "Theo tầng" chỉ hiện khi Epic đa tầng (có per_tier). Epic 1 tầng giữ nguyên UI cũ.
  const hasTiers = data.tierSeries.length > 0;
  const availableModes: ScreenMode[] = hasTiers ? ['EPIC', 'PHASE', 'TIER'] : ['EPIC', 'PHASE'];
  const effectiveMode: ScreenMode = mode === 'TIER' && !hasTiers ? 'EPIC' : mode;

  return (
    <div className="stack">
      <div className="scope">
        <span className="scope__label">Epic:</span>
        <code>{epicKey}</code>
        <button type="button" className="button" onClick={() => setParams({})}>
          Change Epic
        </button>
      </div>

      <div className="tabs" role="tablist" aria-label="Chart view mode">
        {availableModes.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={effectiveMode === m}
            className={`tab${effectiveMode === m ? ' tab--active' : ''}`}
            onClick={() => setMode(m)}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {effectiveMode === 'PHASE' && (
        <PhasePicker phases={phaseKeys} selected={selected} onChange={setSelected} />
      )}

      <section className="panel">
        {effectiveMode === 'TIER' ? (
          <TierDrillView
            tierSeries={data.tierSeries}
            path={tierPath}
            onPath={setTierPath}
            markers={data.markers}
            onPointClick={setExplainDate}
          />
        ) : (
          <ChartArea
            mode={effectiveMode}
            selected={selected}
            series={data.series}
            markers={data.markers}
            onPointClick={setExplainDate}
          />
        )}

        {/*
          Nói thẳng ra rằng đường Kế hoạch được vẽ lại liên tục. Không nói thì PM
          thấy điểm của hôm qua đổi chỗ và tưởng hệ thống hỏng (R-11).
        */}
        <p className="muted">{data.planNote}</p>
      </section>

      {data.dataHealth.missingSnapshotDays.length > 0 && (
        <div className="notice notice--error" role="alert">
          <strong>{data.dataHealth.missingSnapshotDays.length} days have no snapshot:</strong>{' '}
          {data.dataHealth.missingSnapshotDays.join(', ')}. The chart leaves these days blank instead
          of joining across them — the nightly job has most likely failed.
        </div>
      )}

      {/* Cấu hình lịch sai không được im lặng (C-10): lịch thiếu ngày lễ làm
          đường Kế hoạch cháy đều qua tuần nghỉ Tết — trông y hệt team đang chậm. */}
      {data.calendarWarnings.map((warning) => (
        <p className="notice notice--error" role="alert" key={warning}>
          📅 {warning}
        </p>
      ))}

      <MarkerList markers={data.markers} />

      {data.planShiftSummary.shiftCount > 0 && (
        <p className="notice notice--error" role="status">
          The plan has slipped by{' '}
          <strong>{data.planShiftSummary.totalShiftedWorkdays} working days</strong> across{' '}
          {data.planShiftSummary.shiftCount} changes{' '}
          <Badge tone={data.planShiftSummary.warningLevel === 'OK' ? 'muted' : 'danger'}>
            {data.planShiftSummary.warningLevel}
          </Badge>
        </p>
      )}

      {explainDate !== null && (
        <ExplainPanel epicKey={epicKey} date={explainDate} onClose={() => setExplainDate(null)} />
      )}
    </div>
  );
}

function ChartArea({
  mode,
  selected,
  series,
  markers,
  onPointClick,
}: {
  readonly mode: ScreenMode;
  readonly selected: readonly string[];
  readonly series: readonly ChartSeries[];
  readonly markers: BurndownScreenMarkers;
  readonly onPointClick: (date: string) => void;
}) {
  // Lọc TRONG BỘ NHỚ từ dữ liệu đã có — không gọi lại API.
  const shown = useMemo(() => {
    if (mode === 'EPIC') return series.filter((s) => s.key === 'EPIC');
    return series.filter((s) => selected.includes(s.key));
  }, [mode, selected, series]);

  if (shown.length === 0) {
    return (
      <EmptyState
        title="No Phase selected"
        description="Pick at least one Phase above to see the chart."
      />
    );
  }

  return (
    <BurndownChart series={shown} markers={markers} showPlanned onPointClick={onPointClick} />
  );
}

type BurndownScreenMarkers = Parameters<typeof BurndownChart>[0]['markers'];

/**
 * Chế độ "Theo tầng": vẽ CON TRỰC TIẾP của nút đang mở, bấm để drill sâu hơn.
 *
 * Dùng lại BurndownChart (đã tổng quát theo `ChartSeries[]`) — chỉ đổi tập chuỗi
 * truyền vào. `path` là đường drill hiện tại; breadcrumb đi ngược lên.
 */
function TierDrillView({
  tierSeries,
  path,
  onPath,
  markers,
  onPointClick,
}: {
  readonly tierSeries: readonly TierSeries[];
  readonly path: readonly string[];
  readonly onPath: (next: string[]) => void;
  readonly markers: BurndownScreenMarkers;
  readonly onPointClick: (date: string) => void;
}) {
  const children = childrenOf(tierSeries, path);

  return (
    <div className="stack">
      <div className="scope" role="group" aria-label="Đường drill theo tầng">
        <button
          type="button"
          className={`button${path.length === 0 ? ' button--primary' : ''}`}
          onClick={() => onPath([])}
        >
          Toàn Epic
        </button>
        {path.map((code, i) => (
          <span key={i}>
            <span className="muted"> / </span>
            <button type="button" className="button" onClick={() => onPath(path.slice(0, i + 1))}>
              {code}
            </button>
          </span>
        ))}
      </div>

      {children.length === 0 ? (
        <EmptyState title="Nút lá" description="Nút này không còn tầng con để tách nhỏ hơn." />
      ) : (
        <>
          <BurndownChart series={children} markers={markers} showPlanned onPointClick={onPointClick} />
          <div className="scope" role="group" aria-label="Chọn nút con để drill xuống">
            {children.map((c) => {
              const drillable = hasChildren(tierSeries, c.groupPath);
              return (
                <button
                  key={c.key}
                  type="button"
                  className="button"
                  disabled={!drillable}
                  title={drillable ? 'Bấm để mở tầng con' : 'Nút lá — không có tầng con'}
                  onClick={() => onPath([...c.groupPath])}
                >
                  {c.label}
                  {drillable ? ' ▸' : ''}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function PhasePicker({
  phases,
  selected,
  onChange,
}: {
  readonly phases: readonly string[];
  readonly selected: readonly string[];
  readonly onChange: (next: string[]) => void;
}) {
  // Chỉ chọn MỘT Phase: bấm Phase nào thì xem đúng Phase đó (chế độ so sánh
  // nhiều Phase đã gỡ).
  return (
    <div className="scope" role="group" aria-label="Select Phases">
      {phases.map((code) => (
        <button
          key={code}
          type="button"
          className={`button${selected.includes(code) ? ' button--primary' : ''}`}
          aria-pressed={selected.includes(code)}
          onClick={() => onChange([code])}
        >
          {code}
        </button>
      ))}
    </div>
  );
}

function MarkerList({ markers }: { readonly markers: BurndownScreenMarkers }) {
  if (markers.length === 0) return null;

  return (
    <section className="panel" aria-labelledby="markers-title">
      <h2 className="panel__title" id="markers-title">
        Chart markers
      </h2>
      <ul className="rows">
        {markers.map((m, i) => (
          <li className="row" key={`${m.type}-${m.date}-${i}`}>
            <code>{m.date}</code>
            <Badge tone={m.type === 'PLAN_SHIFTED' ? 'danger' : 'warning'}>
              {m.type === 'PLAN_SHIFTED' ? '⚑ plan moved' : '↑ scope added'}
            </Badge>
            <span>{m.detail}</span>
            {m.causedByKeys.length > 0 && <span className="muted">{m.causedByKeys.join(', ')}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExplainPanel({
  epicKey,
  date,
  onClose,
}: {
  readonly epicKey: string;
  readonly date: string;
  readonly onClose: () => void;
}) {
  const query = useExplainDay(epicKey, date);

  const columns: readonly Column<ExplainRow>[] = [
    {
      key: 'issue',
      header: 'Sub-task',
      render: (r) => (
        <span>
          <code>{r.issueKey}</code> {r.summary}
        </span>
      ),
      sortKey: (r) => r.issueKey,
    },
    { key: 'phase', header: 'Phase', render: (r) => r.phaseCode, sortKey: (r) => r.phaseCode },
    {
      key: 'rule',
      header: 'Rule',
      render: (r) => (
        <span>
          <Badge tone={r.appliedRule === 2 ? 'warning' : 'muted'}>Rule {r.appliedRule}</Badge>
          <div className="muted">{r.ruleExplanation}</div>
          {/* Đây là thứ runbook bảo đi tìm khi PM báo số liệu sai. */}
          {r.estimateOverride !== null && (
            <div className="muted">
              Manually set to {r.estimateOverride.valueHours}h at {r.estimateOverride.changedAt}
              {r.estimateOverride.changedBy !== null && ` by ${r.estimateOverride.changedBy}`}
            </div>
          )}
        </span>
      ),
      sortKey: (r) => r.appliedRule,
    },
    {
      key: 'remaining',
      header: 'Remaining (h)',
      align: 'right',
      render: (r) => r.remainingHours,
      sortKey: (r) => r.remainingHours,
    },
  ];

  return (
    <section className="panel" aria-labelledby="explain-title">
      <h2 className="panel__title" id="explain-title">
        Where the {date} number comes from
      </h2>

      {query.isPending && <LoadingState label="Recomputing from raw data…" rows={3} />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {query.isSuccess && (
        <>
          {query.data.mismatch !== null && (
            <div className="notice notice--error" role="alert">
              <strong>Stored number differs from the recomputed one:</strong> the snapshot says{' '}
              {query.data.mismatch.storedHours}h, recomputing gives{' '}
              {query.data.mismatch.recomputedHours}h (a {query.data.mismatch.differenceHours}h gap).
              The snapshot is most likely stale — click Resync on the Epics screen.
            </div>
          )}

          <DataTable
            caption={`How many hours each sub-task contributed on ${date}`}
            columns={columns}
            rows={query.data.rows}
            rowKey={(r) => r.issueKey}
          />
        </>
      )}

      <div className="actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
