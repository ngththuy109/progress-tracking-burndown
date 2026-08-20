import { useReducer, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  deriveDefaultTiersFromPhase,
  type ConfigPayload,
  type EffectiveConfig,
  type GroupSourceType,
  type GroupTier,
  type GroupTierRule,
  type TiersPreviewRow,
} from '@app/shared';
import { useEffectiveConfig, useSaveConfig, useTiersPreview } from '../../api/use-phase-config.js';
import { Badge, ErrorState, LoadingState } from '../../components/ui/index.js';
import { indexIssues, issuesOf, NO_ISSUES } from '../config-phase/field-errors.js';
import { DeleteButton, IssueList, MoveButtons } from '../config-phase/row-controls.js';
import {
  isTierDirty,
  loadTierDraft,
  phaseTierCount,
  tierReducer,
  TIER_PRESETS,
  type TierAction,
} from './tier-draft.js';

/**
 * Màn "Cấu trúc tầng" — khai 1..N tầng nhóm logic cho dự án (DYNAMIC-TIERS-DESIGN.md).
 *
 * CHẠY TRÊN GLOBAL (single-tenant = một cấu hình). Nhờ vậy không phải lo kế thừa:
 * lưu = gửi lại nguyên payload GLOBAL, chỉ thay phần `tiers`. Bộ máy tầng nhóm tách
 * riêng khỏi màn Phase settings để reducer mỗi bên gọn.
 *
 * Vòng 3: hỗ trợ nguồn khoá dựa tiêu đề (Task cha / chính lá). LABEL / token / custom
 * field mở sau — chỉ hiện những nguồn engine đã chạy được.
 */

/** Chỉ hiện nguồn khoá engine ĐÃ hỗ trợ (resolver Vòng 3). CUSTOM_FIELD để v2. */
const SUPPORTED_SOURCES: readonly { readonly value: GroupSourceType; readonly label: string }[] = [
  { value: 'PARENT_TASK_TITLE', label: 'Parent Task title' },
  { value: 'SELF_TITLE', label: 'Leaf’s own title' },
  { value: 'SUBTASK_TITLE_TOKEN', label: 'Sub-task title token' },
  { value: 'LABEL', label: 'Jira label' },
];

/** Ghi chú ngắn cạnh nguồn — đúng dòng "source: … (chú thích)" của demo. */
const SOURCE_NOTE: Record<string, string> = {
  PARENT_TASK_TITLE: 'parsed from the parent Task’s title',
  SELF_TITLE: 'parsed from the leaf’s OWN title',
  SUBTASK_TITLE_TOKEN: 'takes one token from the Sub-task title pattern',
  LABEL: 'taken from a Jira label by prefix',
};

/** Token bóc được từ mẫu tiêu đề Sub-task chuẩn. */
const TOKEN_OPTIONS = ['project', 'team', 'phase', 'function', 'task'] as const;

/** Bóc phần ConfigPayload ra khỏi EffectiveConfig (bỏ meta scope/version/inherited). */
function payloadFromConfig(c: EffectiveConfig): ConfigPayload {
  return {
    fallbackScanFullTitle: c.fallbackScanFullTitle,
    titlePatterns: c.titlePatterns,
    subtaskPatterns: c.subtaskPatterns,
    phaseDefinitions: c.phaseDefinitions,
    matchRules: c.matchRules,
    signboardColumns: c.signboardColumns,
    subPhaseOrders: c.subPhaseOrders,
  };
}

export function TierStructureScreen() {
  const query = useEffectiveConfig(null); // GLOBAL — single-tenant

  if (query.isPending) return <LoadingState label="Loading the tier structure…" rows={3} />;
  if (query.isError) {
    return (
      <ErrorState error={query.error} title="Could not load the tier structure" onRetry={() => void query.refetch()} />
    );
  }

  return (
    <div className="stack">
      <TierEditor key="GLOBAL" config={query.data} />
    </div>
  );
}

function TierEditor({ config }: { readonly config: EffectiveConfig }) {
  const initialTiers =
    config.tiers && config.tiers.length > 0 ? config.tiers : deriveDefaultTiersFromPhase(config);
  const [state, dispatch] = useReducer(tierReducer, initialTiers, loadTierDraft);
  const [note, setNote] = useState('');
  const save = useSaveConfig();
  const errors = save.isError ? indexIssues(issuesOf(save.error)) : NO_ISSUES;

  const phaseCount = phaseTierCount(state);
  const phaseOk = phaseCount === 1;
  const [guideOpen, setGuideOpen] = useState(false);

  return (
    <>
      <ConfigTypeHeader dispatch={dispatch} />

      {/* Thanh hướng dẫn — đúng demo: mở modal 7 bước ngay trong app. */}
      <div className="glbar">
        <span aria-hidden="true">📖</span>
        <span>
          <strong>Not sure where to start?</strong> See the step-by-step guide to setting up the
          tier configuration for a project.
        </span>
        <button type="button" className="glbar__open" onClick={() => setGuideOpen(true)}>
          Open the setup guide →
        </button>
      </div>
      {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}

      {!phaseOk && (
        <p className="notice notice--error" role="alert">
          {phaseCount === 0
            ? 'No tier is marked as Phase yet. Mark exactly one tier as the Phase tier.'
            : `${phaseCount} tiers are marked as Phase. Exactly one is allowed.`}
        </p>
      )}

      {/* Bố cục hai cột của demo: trái = Bước 1 + Bước 2; phải = Xem thử (sticky). */}
      <div className="tiers-grid">
        <div className="stack">
          <ScopeInfoCard />

          <section className="panel" aria-labelledby="tiers-list-title">
            <p className="panel__eyebrow">Step 2 · Grouping tiers</p>
            <h2 className="panel__title" id="tiers-list-title">
              Tier structure{' '}
              <span className="muted">
                · {state.tiers.length} tier{state.tiers.length === 1 ? '' : 's'}
              </span>
            </h2>
            <p className="panel__hint">
              Each tier picks a <strong>key source</strong>, and <strong>exactly one</strong> tier
              is marked as <em>Phase</em> — the tier behind the Signboard and the Planned line.
              Click <strong>Edit ✎</strong> to open the tier’s values/rules/patterns editor.
            </p>

            <ol className="stack tier-list">
              {state.tiers.map((tier, i) => (
                <TierRow
                  key={i}
                  tier={tier}
                  index={i}
                  total={state.tiers.length}
                  errors={errors}
                  dispatch={dispatch}
                />
              ))}
            </ol>

            <button type="button" className="button" onClick={() => dispatch({ type: 'ADD_TIER' })}>
              + Add tier
            </button>

            <IssueList issues={errors.at('tiers')} />
          </section>
        </div>

        <TiersPreviewCard tiers={state.tiers} />
      </div>

      <section className="panel">
        <label className="field">
          <span>Note for this change</span>
          <input
            className="input input--wide"
            value={note}
            placeholder="e.g. split out a Stream tier"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </section>

      {save.isSuccess && (
        <p className="notice notice--ok" role="status">
          Saved as version v{save.data.version}. {save.data.affectedEpics} Epics will be recomputed.
        </p>
      )}
      {save.isError && !errors.hasBlocking && (
        <ErrorState error={save.error} title="Could not save the tier structure" />
      )}
      {errors.hasBlocking && (
        <p className="notice notice--error" role="alert">
          The configuration is not valid, so <strong>nothing was saved</strong>. Check the lines
          marked in red.
        </p>
      )}

      <div className="actions actions--sticky">
        <span className="muted">{isTierDirty(state) ? 'Unsaved changes' : 'No changes yet'}</span>
        <button
          type="button"
          className="button button--primary"
          disabled={!isTierDirty(state) || save.isPending || !phaseOk}
          onClick={() =>
            save.mutate(
              {
                projectKey: null,
                payload: { ...payloadFromConfig(config), tiers: [...state.tiers] },
                note: note === '' ? null : note,
              },
              { onSuccess: () => dispatch({ type: 'COMMIT' }) },
            )
          }
        >
          {save.isPending ? 'Saving…' : '💾 Save tier structure'}
        </button>
      </div>
    </>
  );
}

/**
 * Xem thử — cột phải sticky của demo: dán các tiêu đề Task (mỗi dòng một ticket
 * mẫu) → bảng `tiêu đề → group_path` với chip theo tầng, phần tử tầng Phase có viền.
 *
 * Kiểm ngay tại chỗ, không phải Lưu rồi Resync mới biết luật có ăn không. Chỉ chạy
 * được tầng bóc từ tiêu đề Task cha; tầng nguồn khác hiện "…" (cần dữ liệu lá).
 */
function TiersPreviewCard({ tiers }: { readonly tiers: readonly GroupTier[] }) {
  const [text, setText] = useState('');
  const preview = useTiersPreview();

  const titles = text
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => t !== '');

  const run = (): void => {
    if (titles.length === 0) return;
    preview.mutate({ taskTitles: titles.slice(0, 50), tiers });
  };

  /** Màu chip: tra định nghĩa của ĐÚNG tầng đó trong bản nháp (theo mã đã bóc). */
  const colorOf = (tierIndexInPath: number, code: string): string | null => {
    const sorted = [...tiers].sort((a, b) => a.tierOrder - b.tierOrder);
    return sorted[tierIndexInPath]?.definitions.find((d) => d.groupCode === code)?.colorHex ?? null;
  };

  return (
    <section className="panel tiers-preview" aria-labelledby="tiers-preview-title">
      <p className="panel__eyebrow panel__eyebrow--plain">Preview · no sync needed</p>
      <h2 className="panel__title" id="tiers-preview-title">
        Sample tickets → <code>group_path</code>
      </h2>
      <p className="panel__hint">
        Each leaf becomes a <strong>key vector</strong>, one element per tier. The outlined chip is
        the <em>Phase</em> tier element. Paste real Task titles, one ticket per line.
      </p>

      <textarea
        className="input"
        rows={4}
        value={text}
        placeholder={'[PAY][offshore_P1]Design\n[PAY][offshore_P2]Development'}
        aria-label="Task titles to preview, one ticket per line"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={titles.length === 0 || preview.isPending}
          onClick={run}
        >
          {preview.isPending ? 'Parsing…' : 'Preview'}
        </button>
        {titles.length > 50 && <span className="muted">Only the first 50 lines are parsed.</span>}
      </div>

      {preview.isError && <ErrorState error={preview.error} title="Could not run the preview" />}

      {preview.data && (
        <div className="tbl-scroll" aria-live="polite">
          <table className="tiers-preview__table">
            <thead>
              <tr>
                <th>Title</th>
                <th>group_path</th>
              </tr>
            </thead>
            <tbody>
              {preview.data.results.map((row) => (
                <tr key={row.taskTitle}>
                  <td className="tiers-preview__title">{row.taskTitle}</td>
                  <td>
                    <PathChips row={row} colorOf={colorOf} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="panel__hint">
            A "…" cell = that tier takes its key from LEAF data (leaf title / token / label), so it
            cannot be parsed from a Task title. <code>UNCLASSIFIED</code> = no rule matched — check
            the keywords.
          </p>
        </div>
      )}
    </section>
  );
}

/** Vectơ khoá của một dòng preview — chip theo tầng, phần tử tầng Phase có viền. */
function PathChips({
  row,
  colorOf,
}: {
  readonly row: TiersPreviewRow;
  readonly colorOf: (tierIndexInPath: number, code: string) => string | null;
}) {
  return (
    <span className="gp-path">
      {row.entries.map((e, i) => {
        const color = e.resolved === null ? null : colorOf(i, e.resolved);
        return (
          <span key={e.code} className="gp-path__pair">
            {i > 0 && <span className="gp-sep">›</span>}
            <span
              className={`gp-node${e.role === 'PHASE' ? ' gp-node--phase' : ''}${
                e.resolved === 'UNCLASSIFIED' ? ' gp-node--warn' : ''
              }`}
              style={color === null ? undefined : { borderColor: color, color }}
              title={
                e.resolved === null
                  ? `Tier ${e.labelVi || e.code}: source "${e.sourceType}" needs leaf data`
                  : `Tier ${e.labelVi || e.code}`
              }
            >
              {e.resolved ?? '…'}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * Bước 1 của demo — card MÔ TẢ phạm vi theo dõi (CONTAINER/QUERY). Scope thật được
 * đăng ký THEO TỪNG Epic ở màn Epics; card này giữ đúng vị trí "Bước 1" trong luồng
 * thiết lập để người mới không bỏ sót bước đăng ký scope.
 */
function ScopeInfoCard() {
  return (
    <section className="panel" aria-labelledby="scope-info-title">
      <p className="panel__eyebrow">Step 1 · What to track</p>
      <h2 className="panel__title" id="scope-info-title">
        Tracked scope
      </h2>
      <p className="panel__hint">
        All numbers are computed over each scope’s <strong>leaf set</strong>. Two ways to define
        the leaf set:
      </p>
      <dl className="scope-kv">
        <dt>
          <Badge tone="info">CONTAINER</Badge>
        </dt>
        <dd>
          Register a container Epic/Task — the leaves are its <strong>Sub-tasks/descendants</strong>{' '}
          (the original 3-level model).
        </dd>
        <dt>
          <Badge tone="neutral">QUERY</Badge>
        </dt>
        <dd>
          A flat project with no parent ticket — declare a <strong>JQL</strong>; the leaves are the
          tickets matching the query.
        </dd>
      </dl>
      <p className="panel__hint">
        Register or edit each project’s scope on the <Link to="/epics">Epics</Link> screen. The
        tier structure on this page applies to <strong>every</strong> scope.
      </p>
    </section>
  );
}

/** Header "Choose a tier structure type" — đúng khối đầu trang của demo. */
function ConfigTypeHeader({ dispatch }: { readonly dispatch: (a: TierAction) => void }) {
  return (
    <section className="panel cfg-head" aria-labelledby="preset-title">
      <div>
        <p className="panel__eyebrow">Global configuration · single-tenant</p>
        <h2 className="panel__title" id="preset-title">
          Choose a tier structure type
        </h2>
        <p className="panel__hint">
          Applies to the <strong>whole system</strong> — every tracked scope shares this structure.
          Pick a preset to start quickly, then fine-tune below.
        </p>
      </div>
      <div className="scope" role="group" aria-label="Choose a configuration preset">
        {TIER_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="button"
            title={p.hint}
            onClick={() => dispatch({ type: 'REPLACE_TIERS', tiers: p.build() })}
          >
            {p.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Modal "Hướng dẫn cấu hình" — nội dung 7 bước của demo, ngay trong app. */
function GuideModal({ onClose }: { readonly onClose: () => void }) {
  return (
    <div
      className="guide-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <div className="guide-modal__head">
          <div>
            <p className="panel__eyebrow">Guide</p>
            <h2 className="panel__title" id="guide-title">
              Setting up the tier configuration for a project
            </h2>
          </div>
          <button type="button" className="button" aria-label="Close the guide" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="guide-modal__body">
          <p className="panel__hint">
            The configuration answers three questions: <strong>what to track</strong>,{' '}
            <strong>how many tiers to group by</strong>, and{' '}
            <strong>where each tier takes its key from</strong>. Work through them in order:
          </p>

          <div className="guide-myth">
            <p className="guide-myth__head">⚠️ Two different "levels" — don’t mix them up</p>
            <p>
              🏢 <strong>The Jira house — 3 FIXED levels</strong> (Epic → Task = [Phase] →
              Sub-task): the issue-tree depth, fixed by Jira — the "3-level" in the preset name
              refers to this. 📏 <strong>Grouping tiers — YOU define them (1..N)</strong>: the
              number of "slices" the numbers roll up through; the "3-level" preset sets up just{' '}
              <strong>1</strong> slice = Phase. To group deeper (Stage, Stream…), click{' '}
              <strong>+ Add tier</strong> — there is no limit.
            </p>
          </div>

          <ol className="guide-steps">
            <li>
              <strong>Choose the tracked scope.</strong> Has a parent ticket →{' '}
              <code>CONTAINER</code> (paste the Epic/Task key on the Epics screen). Flat project →{' '}
              <code>QUERY</code> (write a JQL). Leaves = the level carrying the numbers
              (estimate/worklog).
            </li>
            <li>
              <strong>Declare the grouping tiers (1..N), top down.</strong> Each tier gets a name +
              a key source: parent Task title · the leaf’s own title · a title token · a label. At
              least 1 tier.
            </li>
            <li>
              <strong>Mark exactly ONE tier as Phase.</strong> The Phase tier keeps every
              Phase-based feature: Signboard, the Planned line, shift alerts. Other tiers only
              group and roll numbers up.
            </li>
            <li>
              <strong>For title-based tiers: add patterns & rules.</strong> Title patterns (e.g.{' '}
              <code>{'[{project}][{name}]{task}'}</code>) + keyword → code rules (e.g.{' '}
              <code>offshore_P1 → GD1</code>). Use <strong>Preview</strong> on the right to check
              instantly.
            </li>
            <li>
              <strong>Configure Signboard columns (for the Phase tier).</strong> Task types
              (Create/Review/Fix…), the VN/JP side, Sub-task title patterns, Sub-phase order.
            </li>
            <li>
              <strong>Attach a work calendar.</strong> Pick the VN/JP calendar for the scope on the
              Days off screen — it decides how the Planned line is computed.
            </li>
            <li>
              <strong>Preview → Save.</strong> Check <code>group_path</code> in the Preview panel.
              After saving, the system backfills on its own (up to ~1 hour); to see the result
              right away, run a Full resync.
            </li>
          </ol>

          <p className="guide-tip">
            <strong>Golden rule:</strong> only the <strong>leaf level</strong> carries real numbers
            (estimate/worklog/dates). Grouping tiers — Phase included — have no numbers of their
            own; their numbers are <strong>roll-up totals</strong> from the leaves.
          </p>

          <p className="panel__hint">
            Technical details & the "Stage" recipe: <code>docs/DYNAMIC-TIERS-DESIGN.md</code> §9.
            Interactive demo: <code>docs/dynamic-tiers-demo.html</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * MỘT tầng — hàng GỌN theo demo: điều khiển + dòng tóm tắt nguồn/giá trị; phần
 * giá trị/luật/mẫu XẾP LẠI sau nút "Sửa ✎" thay vì trải hết ra màn.
 *
 * Riêng tầng ✦Phase nguồn "Tiêu đề Task cha": engine đọc cấu hình Phase (phase_*)
 * chứ KHÔNG đọc luật khai ở đây, nên "Sửa ✎" dẫn thẳng sang màn Phase settings —
 * trưng trình sửa tại chỗ cho nó là mời người dùng sửa vào chỗ không có tác dụng.
 */
function TierRow({
  tier,
  index,
  total,
  errors,
  dispatch,
}: {
  readonly tier: GroupTier;
  readonly index: number;
  readonly total: number;
  readonly errors: ReturnType<typeof indexIssues>;
  readonly dispatch: (a: TierAction) => void;
}) {
  const name = tier.code === '' ? `tier ${index + 1}` : tier.code;
  const [open, setOpen] = useState(false);
  const editsInPhaseSettings = tier.role === 'PHASE' && tier.sourceType === 'PARENT_TASK_TITLE';
  const sourceLabel =
    SUPPORTED_SOURCES.find((s) => s.value === tier.sourceType)?.label ?? tier.sourceType;

  return (
    <li className="tier-row" aria-label={`Tier ${index + 1}`}>
      <div className="row tier-row__head">
        <MoveButtons
          label={name}
          index={index}
          total={total}
          onMove={(delta) => dispatch({ type: 'MOVE_TIER', index, delta })}
        />
        <span className="tier-row__ord" aria-hidden="true">
          {tier.tierOrder}
        </span>
        <input
          className="input"
          value={tier.labelVi}
          placeholder="Display name"
          aria-label={`Tier ${index + 1} name`}
          onChange={(e) => dispatch({ type: 'UPDATE_TIER', index, patch: { labelVi: e.target.value } })}
        />
        {tier.role === 'PHASE' ? <Badge tone="success">PHASE</Badge> : <Badge tone="neutral">GROUP</Badge>}
        <input
          className="input input--code"
          value={tier.code}
          placeholder="Tier code"
          aria-label={`Tier ${index + 1} code`}
          onChange={(e) => dispatch({ type: 'UPDATE_TIER', index, patch: { code: e.target.value } })}
        />
        <label className="field field--inline">
          <input
            type="radio"
            name="phase-tier"
            checked={tier.role === 'PHASE'}
            aria-label={`Mark tier ${index + 1} as the Phase tier`}
            onChange={() => dispatch({ type: 'SET_PHASE_TIER', index })}
          />
          <span>Phase tier</span>
        </label>
        {editsInPhaseSettings ? (
          <Link className="button" to="/config/phase" title="The Phase tier’s values & rules are edited in Phase settings">
            Edit ✎
          </Link>
        ) : (
          <button
            type="button"
            className="button"
            aria-expanded={open}
            aria-label={`Edit values/rules/patterns of tier ${index + 1}`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Collapse ▴' : 'Edit ✎'}
          </button>
        )}
        <DeleteButton label={name} onClick={() => dispatch({ type: 'REMOVE_TIER', index })} />
      </div>

      {/* Dòng tóm tắt như demo: "nguồn: X (chú thích)" + chips giá trị chuẩn. */}
      <div className="tier-row__src">
        <span className="muted">source:</span>
        <select
          className="input input--sm"
          value={tier.sourceType}
          aria-label={`Tier ${index + 1} key source`}
          onChange={(e) =>
            dispatch({ type: 'UPDATE_TIER', index, patch: { sourceType: e.target.value as GroupSourceType } })
          }
        >
          {/* Nếu tầng đang mang nguồn CHƯA hỗ trợ (từ config cũ) vẫn hiện để không mất. */}
          {!SUPPORTED_SOURCES.some((s) => s.value === tier.sourceType) && (
            <option value={tier.sourceType}>{tier.sourceType} (not supported yet)</option>
          )}
          {SUPPORTED_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="muted">{SOURCE_NOTE[tier.sourceType] ?? sourceLabel}</span>
        {editsInPhaseSettings ? (
          <span className="muted">
            · values & rules live in <Link to="/config/phase">Phase settings</Link>
          </span>
        ) : (
          tier.definitions.length > 0 && (
            <span className="tier-row__defs">
              {tier.definitions.map((d, j) => (
                <span
                  key={j}
                  className="defchip"
                  style={d.colorHex == null ? undefined : { borderColor: d.colorHex, color: d.colorHex }}
                >
                  {d.groupCode || '—'}
                </span>
              ))}
            </span>
          )
        )}
      </div>

      <TierSourceParam tier={tier} index={index} dispatch={dispatch} />

      <IssueList issues={errors.atRow('tiers', index)} />

      {open && !editsInPhaseSettings && (
        <div className="tier-row__editor">
          <TierDefinitions tier={tier} index={index} dispatch={dispatch} />
          <TierRules tier={tier} index={index} dispatch={dispatch} />
          <TierPatterns tier={tier} index={index} dispatch={dispatch} />
        </div>
      )}
    </li>
  );
}

/** Tham số phụ của nguồn khoá: tên token (SUBTASK_TITLE_TOKEN) hoặc tiền tố (LABEL). */
function TierSourceParam({
  tier,
  index,
  dispatch,
}: {
  readonly tier: GroupTier;
  readonly index: number;
  readonly dispatch: (a: TierAction) => void;
}) {
  if (tier.sourceType === 'SUBTASK_TITLE_TOKEN') {
    const token = String(tier.sourceConfig?.['token'] ?? '');
    return (
      <label className="field field--inline">
        <span>Token</span>
        <select
          className="input"
          value={token}
          aria-label={`Tier ${index + 1} source token`}
          onChange={(e) => dispatch({ type: 'SET_SOURCE_CONFIG', index, key: 'token', value: e.target.value })}
        >
          <option value="">(pick a token)</option>
          {TOKEN_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (tier.sourceType === 'LABEL') {
    const prefix = String(tier.sourceConfig?.['prefix'] ?? '');
    return (
      <label className="field field--inline">
        <span>Label prefix</span>
        <input
          className="input input--code"
          value={prefix}
          placeholder="team:"
          aria-label={`Tier ${index + 1} label prefix`}
          onChange={(e) => dispatch({ type: 'SET_SOURCE_CONFIG', index, key: 'prefix', value: e.target.value })}
        />
      </label>
    );
  }
  return null;
}

function TierDefinitions({
  tier,
  index,
  dispatch,
}: {
  readonly tier: GroupTier;
  readonly index: number;
  readonly dispatch: (a: TierAction) => void;
}) {
  return (
    <fieldset className="subsection">
      <legend>Canonical tier values</legend>
      <ul className="rows">
        {tier.definitions.map((d, j) => (
          <li className="row" key={j}>
            <input
              className="input input--code"
              value={d.groupCode}
              placeholder="Code"
              aria-label={`Value ${j + 1} code of tier ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_DEF', tier: index, index: j, patch: { groupCode: e.target.value } })}
            />
            <input
              className="input"
              value={d.labelVi}
              placeholder="Name"
              aria-label={`Value ${j + 1} name of tier ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_DEF', tier: index, index: j, patch: { labelVi: e.target.value } })}
            />
            <input
              className="input input--color"
              type="color"
              value={d.colorHex ?? '#888888'}
              aria-label={`Value ${j + 1} color of tier ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_DEF', tier: index, index: j, patch: { colorHex: e.target.value } })}
            />
            <DeleteButton label={d.groupCode || `value ${j + 1}`} onClick={() => dispatch({ type: 'REMOVE_DEF', tier: index, index: j })} />
          </li>
        ))}
      </ul>
      <button type="button" className="button button--small" onClick={() => dispatch({ type: 'ADD_DEF', tier: index })}>
        + Add value
      </button>
    </fieldset>
  );
}

function TierRules({
  tier,
  index,
  dispatch,
}: {
  readonly tier: GroupTier;
  readonly index: number;
  readonly dispatch: (a: TierAction) => void;
}) {
  return (
    <fieldset className="subsection">
      <legend>Keyword → code match rules</legend>
      <ul className="rows">
        {tier.rules.map((r, j) => (
          <li className="row" key={j}>
            <input
              className="input"
              value={r.keyword}
              placeholder="Keyword"
              aria-label={`Rule ${j + 1} keyword of tier ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_RULE', tier: index, index: j, patch: { keyword: e.target.value } })}
            />
            <select
              className="input"
              value={r.matchMode}
              aria-label={`Rule ${j + 1} match mode of tier ${index + 1}`}
              onChange={(e) =>
                dispatch({
                  type: 'UPDATE_RULE',
                  tier: index,
                  index: j,
                  patch: { matchMode: e.target.value as GroupTierRule['matchMode'] },
                })
              }
            >
              <option value="CONTAINS">Contains</option>
              <option value="REGEX">Regex</option>
            </select>
            <span className="muted">→</span>
            <input
              className="input input--code"
              value={r.groupCode}
              placeholder="Code"
              aria-label={`Rule ${j + 1} target code of tier ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_RULE', tier: index, index: j, patch: { groupCode: e.target.value } })}
            />
            <input
              className="input input--number"
              type="number"
              value={r.matchPriority}
              aria-label={`Rule ${j + 1} priority of tier ${index + 1}`}
              onChange={(e) =>
                dispatch({ type: 'UPDATE_RULE', tier: index, index: j, patch: { matchPriority: Number(e.target.value) } })
              }
            />
            <DeleteButton label={r.keyword || `rule ${j + 1}`} onClick={() => dispatch({ type: 'REMOVE_RULE', tier: index, index: j })} />
          </li>
        ))}
      </ul>
      <button type="button" className="button button--small" onClick={() => dispatch({ type: 'ADD_RULE', tier: index })}>
        + Add rule
      </button>
    </fieldset>
  );
}

function TierPatterns({
  tier,
  index,
  dispatch,
}: {
  readonly tier: GroupTier;
  readonly index: number;
  readonly dispatch: (a: TierAction) => void;
}) {
  return (
    <fieldset className="subsection">
      <legend>Title patterns (optional)</legend>
      <ul className="rows">
        {tier.titlePatterns.map((p, j) => (
          <li className="row" key={j}>
            <input
              className="input input--wide"
              value={p.patternText}
              placeholder="[{name}] {rest}"
              aria-label={`Title pattern ${j + 1} of tier ${index + 1}`}
              onChange={(e) =>
                dispatch({ type: 'UPDATE_PATTERN', tier: index, index: j, patch: { patternText: e.target.value } })
              }
            />
            <DeleteButton label={`pattern ${j + 1}`} onClick={() => dispatch({ type: 'REMOVE_PATTERN', tier: index, index: j })} />
          </li>
        ))}
      </ul>
      <button type="button" className="button button--small" onClick={() => dispatch({ type: 'ADD_PATTERN', tier: index })}>
        + Add pattern
      </button>
    </fieldset>
  );
}
