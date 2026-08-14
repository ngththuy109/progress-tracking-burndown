import { useReducer, useState } from 'react';
import {
  deriveDefaultTiersFromPhase,
  type ConfigPayload,
  type EffectiveConfig,
  type GroupSourceType,
  type GroupTier,
  type GroupTierRule,
} from '@app/shared';
import { useEffectiveConfig, useSaveConfig } from '../../api/use-phase-config.js';
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
  { value: 'PARENT_TASK_TITLE', label: 'Tiêu đề Task cha' },
  { value: 'SELF_TITLE', label: 'Tiêu đề chính lá' },
  { value: 'SUBTASK_TITLE_TOKEN', label: 'Token trong tiêu đề Sub-task' },
  { value: 'LABEL', label: 'Nhãn Jira (label)' },
];

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

  if (query.isPending) return <LoadingState label="Đang tải cấu trúc tầng…" rows={3} />;
  if (query.isError) {
    return (
      <ErrorState error={query.error} title="Không tải được cấu trúc tầng" onRetry={() => void query.refetch()} />
    );
  }

  return (
    <div className="stack">
      <section className="panel">
        <p className="panel__hint">
          Mỗi tầng là một mức gom nhóm logic (Stream, Phase, Sub-phase…). Kéo dữ liệu cộng dồn từ
          lá lên theo <strong>từng tiền tố</strong> của vectơ khoá. <strong>Đúng một tầng</strong>{' '}
          được đánh dấu là <em>Phase</em> — tầng gắn với Signboard và đường Kế hoạch. Xem hướng dẫn
          chi tiết ở <code>docs/DYNAMIC-TIERS-DESIGN.md</code>.
        </p>
      </section>
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

  return (
    <>
      <ConfigTypePresets dispatch={dispatch} />

      {!phaseOk && (
        <p className="notice notice--error" role="alert">
          {phaseCount === 0
            ? 'Chưa có tầng nào là Phase. Đánh dấu đúng một tầng là Phase.'
            : `Có ${phaseCount} tầng đang là Phase. Chỉ được đúng một.`}
        </p>
      )}

      <ol className="stack">
        {state.tiers.map((tier, i) => (
          <TierCard
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
        + Thêm tầng
      </button>

      <IssueList issues={errors.at('tiers')} />

      <section className="panel">
        <label className="field">
          <span>Ghi chú cho thay đổi này</span>
          <input
            className="input input--wide"
            value={note}
            placeholder="Ví dụ: tách thêm tầng Stream"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </section>

      {save.isSuccess && (
        <p className="notice notice--ok" role="status">
          Đã lưu bản v{save.data.version}. {save.data.affectedEpics} Epic sẽ được tính lại.
        </p>
      )}
      {save.isError && !errors.hasBlocking && (
        <ErrorState error={save.error} title="Không lưu được cấu trúc tầng" />
      )}
      {errors.hasBlocking && (
        <p className="notice notice--error" role="alert">
          Cấu hình chưa hợp lệ nên <strong>chưa lưu gì cả</strong>. Xem các dòng báo đỏ.
        </p>
      )}

      <div className="actions actions--sticky">
        <span className="muted">{isTierDirty(state) ? 'Có thay đổi chưa lưu' : 'Chưa thay đổi'}</span>
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
          {save.isPending ? 'Đang lưu…' : '💾 Lưu cấu trúc tầng'}
        </button>
      </div>
    </>
  );
}

function ConfigTypePresets({ dispatch }: { readonly dispatch: (a: TierAction) => void }) {
  return (
    <section className="panel" aria-labelledby="preset-title">
      <h2 className="panel__title" id="preset-title">
        Kiểu cấu hình
      </h2>
      <p className="panel__hint">Chọn một mẫu để bắt đầu nhanh, rồi tinh chỉnh bên dưới.</p>
      <div className="scope">
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

function TierCard({
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
  const name = tier.code === '' ? `tầng ${index + 1}` : tier.code;

  return (
    <li className="panel" aria-label={`Tầng ${index + 1}`}>
      <div className="row">
        <MoveButtons
          label={name}
          index={index}
          total={total}
          onMove={(delta) => dispatch({ type: 'MOVE_TIER', index, delta })}
        />
        <span className="row__order muted">#{tier.tierOrder}</span>
        <input
          className="input input--code"
          value={tier.code}
          placeholder="Mã tầng"
          aria-label={`Mã tầng ${index + 1}`}
          onChange={(e) => dispatch({ type: 'UPDATE_TIER', index, patch: { code: e.target.value } })}
        />
        <input
          className="input"
          value={tier.labelVi}
          placeholder="Tên hiển thị"
          aria-label={`Tên tầng ${index + 1}`}
          onChange={(e) => dispatch({ type: 'UPDATE_TIER', index, patch: { labelVi: e.target.value } })}
        />
        <label className="field field--inline">
          <input
            type="radio"
            name="phase-tier"
            checked={tier.role === 'PHASE'}
            aria-label={`Đặt tầng ${index + 1} là Phase`}
            onChange={() => dispatch({ type: 'SET_PHASE_TIER', index })}
          />
          <span>Là tầng Phase</span>
        </label>
        {tier.role === 'PHASE' && <Badge tone="success">Phase</Badge>}
        <select
          className="input"
          value={tier.sourceType}
          aria-label={`Nguồn khoá tầng ${index + 1}`}
          onChange={(e) =>
            dispatch({ type: 'UPDATE_TIER', index, patch: { sourceType: e.target.value as GroupSourceType } })
          }
        >
          {/* Nếu tầng đang mang nguồn CHƯA hỗ trợ (từ config cũ) vẫn hiện để không mất. */}
          {!SUPPORTED_SOURCES.some((s) => s.value === tier.sourceType) && (
            <option value={tier.sourceType}>{tier.sourceType} (chưa hỗ trợ)</option>
          )}
          {SUPPORTED_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <DeleteButton label={name} onClick={() => dispatch({ type: 'REMOVE_TIER', index })} />
      </div>

      <TierSourceParam tier={tier} index={index} dispatch={dispatch} />

      <IssueList issues={errors.atRow('tiers', index)} />

      <TierDefinitions tier={tier} index={index} dispatch={dispatch} />
      <TierRules tier={tier} index={index} dispatch={dispatch} />
      <TierPatterns tier={tier} index={index} dispatch={dispatch} />
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
          aria-label={`Token nguồn tầng ${index + 1}`}
          onChange={(e) => dispatch({ type: 'SET_SOURCE_CONFIG', index, key: 'token', value: e.target.value })}
        >
          <option value="">(chọn token)</option>
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
        <span>Tiền tố nhãn</span>
        <input
          className="input input--code"
          value={prefix}
          placeholder="team:"
          aria-label={`Tiền tố nhãn tầng ${index + 1}`}
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
      <legend>Giá trị chuẩn của tầng</legend>
      <ul className="rows">
        {tier.definitions.map((d, j) => (
          <li className="row" key={j}>
            <input
              className="input input--code"
              value={d.groupCode}
              placeholder="Mã"
              aria-label={`Mã giá trị ${j + 1} của tầng ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_DEF', tier: index, index: j, patch: { groupCode: e.target.value } })}
            />
            <input
              className="input"
              value={d.labelVi}
              placeholder="Tên"
              aria-label={`Tên giá trị ${j + 1} của tầng ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_DEF', tier: index, index: j, patch: { labelVi: e.target.value } })}
            />
            <input
              className="input input--color"
              type="color"
              value={d.colorHex ?? '#888888'}
              aria-label={`Màu giá trị ${j + 1} của tầng ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_DEF', tier: index, index: j, patch: { colorHex: e.target.value } })}
            />
            <DeleteButton label={d.groupCode || `giá trị ${j + 1}`} onClick={() => dispatch({ type: 'REMOVE_DEF', tier: index, index: j })} />
          </li>
        ))}
      </ul>
      <button type="button" className="button button--small" onClick={() => dispatch({ type: 'ADD_DEF', tier: index })}>
        + Thêm giá trị
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
      <legend>Luật khớp từ khoá → mã</legend>
      <ul className="rows">
        {tier.rules.map((r, j) => (
          <li className="row" key={j}>
            <input
              className="input"
              value={r.keyword}
              placeholder="Từ khoá"
              aria-label={`Từ khoá luật ${j + 1} của tầng ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_RULE', tier: index, index: j, patch: { keyword: e.target.value } })}
            />
            <select
              className="input"
              value={r.matchMode}
              aria-label={`Chế độ khớp luật ${j + 1} của tầng ${index + 1}`}
              onChange={(e) =>
                dispatch({
                  type: 'UPDATE_RULE',
                  tier: index,
                  index: j,
                  patch: { matchMode: e.target.value as GroupTierRule['matchMode'] },
                })
              }
            >
              <option value="CONTAINS">Chứa</option>
              <option value="REGEX">Regex</option>
            </select>
            <span className="muted">→</span>
            <input
              className="input input--code"
              value={r.groupCode}
              placeholder="Mã"
              aria-label={`Mã đích luật ${j + 1} của tầng ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_RULE', tier: index, index: j, patch: { groupCode: e.target.value } })}
            />
            <input
              className="input input--number"
              type="number"
              value={r.matchPriority}
              aria-label={`Ưu tiên luật ${j + 1} của tầng ${index + 1}`}
              onChange={(e) =>
                dispatch({ type: 'UPDATE_RULE', tier: index, index: j, patch: { matchPriority: Number(e.target.value) } })
              }
            />
            <DeleteButton label={r.keyword || `luật ${j + 1}`} onClick={() => dispatch({ type: 'REMOVE_RULE', tier: index, index: j })} />
          </li>
        ))}
      </ul>
      <button type="button" className="button button--small" onClick={() => dispatch({ type: 'ADD_RULE', tier: index })}>
        + Thêm luật
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
      <legend>Mẫu tiêu đề (tuỳ chọn)</legend>
      <ul className="rows">
        {tier.titlePatterns.map((p, j) => (
          <li className="row" key={j}>
            <input
              className="input input--wide"
              value={p.patternText}
              placeholder="[{name}] {rest}"
              aria-label={`Mẫu tiêu đề ${j + 1} của tầng ${index + 1}`}
              onChange={(e) =>
                dispatch({ type: 'UPDATE_PATTERN', tier: index, index: j, patch: { patternText: e.target.value } })
              }
            />
            <DeleteButton label={`mẫu ${j + 1}`} onClick={() => dispatch({ type: 'REMOVE_PATTERN', tier: index, index: j })} />
          </li>
        ))}
      </ul>
      <button type="button" className="button button--small" onClick={() => dispatch({ type: 'ADD_PATTERN', tier: index })}>
        + Thêm mẫu
      </button>
    </fieldset>
  );
}
