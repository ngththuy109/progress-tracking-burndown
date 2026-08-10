import {
  DEFAULT_HIERARCHY_PROFILE,
  MAX_HIERARCHY_LEVELS,
  TITLE_SLOTS,
  resolveHierarchyProfile,
  type HierarchyProfile,
  type PhaseSourceType,
  type SbDimensionSource,
} from '@app/shared';
import type { DraftAction, DraftState } from './draft-state.js';
import type { FieldErrorIndex } from './field-errors.js';
import { InheritNotice } from './inherit-notice.js';
import { IssueList } from './row-controls.js';

/**
 * Khu "Cấu trúc dự án" — Hierarchy Profile (docs/FLEXIBLE-HIERARCHY-PROPOSAL.md).
 *
 * Một dự án 2 tầng (ticket Task là "project", Sub-task là task của từng phase)
 * chỉnh Ở ĐÂY là chạy được — không sửa code, không deploy. Đổi profile là TÁI
 * PHÂN LOẠI ticket thật, nên nút Lưu đi qua đúng luồng Preview → Confirm của cả
 * màn hình.
 */

const PHASE_SOURCE_LABEL: Record<PhaseSourceType, string> = {
  GROUP_TITLE: 'Title of the middle (Phase Task) level — the current 3-tier behaviour',
  SELF_TITLE_SLOT: 'A slot in the leaf ticket title (e.g. [phase])',
  FIELD: 'A Jira field on the leaf ticket (labels, components, customfield_…)',
  FIXED: 'One fixed Phase for the whole project',
};

/** Nguồn nào cần nhập thêm gì vào ô `ref`. */
function refHint(type: PhaseSourceType): string | null {
  switch (type) {
    case 'GROUP_TITLE':
      return null;
    case 'SELF_TITLE_SLOT':
      return `Slot name (one of: ${TITLE_SLOTS.join(', ')}); empty = phase`;
    case 'FIELD':
      return 'Jira field id or name, e.g. labels, components, customfield_10123';
    case 'FIXED':
      return 'Phase code from the Phase list, e.g. DEVELOPMENT';
  }
}

export interface HierarchySectionProps {
  readonly state: DraftState;
  readonly errors: FieldErrorIndex;
  readonly dispatch: (action: DraftAction) => void;
}

export function HierarchySection({ state, errors, dispatch }: HierarchySectionProps) {
  const profile = resolveHierarchyProfile(state.draft.hierarchyProfile);
  const disabled = state.projectKey !== null && state.inherited.hierarchyProfile;

  const set = (next: HierarchyProfile): void => dispatch({ type: 'SET_HIERARCHY', profile: next });

  const setLevelCount = (count: number): void => {
    // Dựng lại mảng tầng theo vị trí (đầu ROOT, cuối LEAF, giữa GROUP), GIỮ
    // issueTypes của ROOT — thường là ràng buộc "root phải là Epic/Task".
    const levels: HierarchyProfile['levels'] = Array.from({ length: count }, (_, i) => ({
      role: i === 0 ? 'ROOT' : i === count - 1 ? 'LEAF' : 'GROUP',
      ...(i === 0 && profile.levels[0]?.issueTypes
        ? { issueTypes: profile.levels[0].issueTypes }
        : {}),
    }));
    // 2 tầng không có tầng GROUP để đọc tiêu đề — tự chuyển nguồn Phase sang ô
    // [phase] trong tiêu đề lá thay vì để cấu hình rơi vào trạng thái chắc
    // chắn bị máy chủ từ chối.
    const phaseSource =
      count < 3 && profile.phaseSource.type === 'GROUP_TITLE'
        ? ({ type: 'SELF_TITLE_SLOT', ref: 'phase' } as const)
        : profile.phaseSource;
    set({ ...profile, levels, phaseSource });
  };

  const rootTypes = profile.levels[0]?.issueTypes ?? [];

  return (
    <section className="panel" aria-labelledby="hierarchy-title">
      <h2 className="panel__title" id="hierarchy-title">
        Project structure
      </h2>
      <p className="panel__hint">
        How this project&apos;s Jira tree maps onto the chart: the ROOT you register, optional
        middle (GROUP) levels, and the LEAF tickets that carry estimates and worklogs. Two-tier
        projects (a Task ticket as the root, sub-tasks per phase) only need changes here.
      </p>

      <InheritNotice
        part="hierarchyProfile"
        partLabel="Project structure"
        inherited={state.inherited.hierarchyProfile}
        projectKey={state.projectKey}
        onOverride={(part) => dispatch({ type: 'OVERRIDE_PART', part })}
      />

      <div className="rows">
        <label className="field">
          <span>Number of levels</span>
          <select
            className="input"
            value={profile.levels.length}
            disabled={disabled}
            aria-label="Number of levels"
            onChange={(e) => setLevelCount(Number(e.target.value))}
          >
            {Array.from({ length: MAX_HIERARCHY_LEVELS - 1 }, (_, i) => i + 2).map((n) => (
              <option key={n} value={n}>
                {n} levels ({['ROOT', ...Array<string>(n - 2).fill('GROUP'), 'LEAF'].join(' → ')})
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Issue types accepted as ROOT (comma separated; empty = any)</span>
          <input
            className="input input--wide"
            value={rootTypes.join(', ')}
            disabled={disabled}
            aria-label="Root issue types"
            placeholder="e.g. EPIC — or Task for a two-tier project"
            onChange={(e) => {
              const parsed = e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s !== '');
              const [root, ...rest] = profile.levels;
              if (!root) return;
              set({
                ...profile,
                levels: [
                  parsed.length > 0 ? { ...root, issueTypes: parsed } : { role: root.role },
                  ...rest,
                ],
              });
            }}
          />
        </label>

        <label className="field">
          <span>Where the Phase of a leaf ticket comes from</span>
          <select
            className="input input--wide"
            value={profile.phaseSource.type}
            disabled={disabled}
            aria-label="Phase source"
            onChange={(e) => {
              const type = e.target.value as PhaseSourceType;
              set({
                ...profile,
                phaseSource: type === 'SELF_TITLE_SLOT' ? { type, ref: 'phase' } : { type, ref: null },
              });
            }}
          >
            {(Object.keys(PHASE_SOURCE_LABEL) as PhaseSourceType[])
              // GROUP_TITLE cần ít nhất một tầng GROUP — cây 2 tầng không có.
              .filter((t) => t !== 'GROUP_TITLE' || profile.levels.length >= 3)
              .map((t) => (
                <option key={t} value={t}>
                  {PHASE_SOURCE_LABEL[t]}
                </option>
              ))}
          </select>
        </label>

        {refHint(profile.phaseSource.type) !== null && (
          <label className="field">
            <span>{refHint(profile.phaseSource.type)}</span>
            <input
              className="input"
              value={profile.phaseSource.ref ?? ''}
              disabled={disabled}
              aria-label="Phase source ref"
              onChange={(e) =>
                set({
                  ...profile,
                  phaseSource: { ...profile.phaseSource, ref: e.target.value || null },
                })
              }
            />
          </label>
        )}

        <DimensionPicker
          label="Signboard rows (function) come from"
          dim={profile.signboard.row}
          disabled={disabled}
          onChange={(row) => set({ ...profile, signboard: { ...profile.signboard, row } })}
        />
        <DimensionPicker
          label="Signboard columns (task type) come from"
          dim={profile.signboard.column}
          disabled={disabled}
          onChange={(column) => set({ ...profile, signboard: { ...profile.signboard, column } })}
        />
      </div>

      {JSON.stringify(profile) !== JSON.stringify(DEFAULT_HIERARCHY_PROFILE) && (
        <p className="muted">
          Changing the structure reclassifies real tickets — run <strong>Preview</strong> before
          saving, and expect a recompute of tracked roots afterwards.
        </p>
      )}

      {/* Đường dẫn lỗi của profile có dạng lồng nhau (hierarchyProfile.phaseSource.ref)
          — gom mọi lỗi dưới tiền tố này về chân khu, khỏi rơi vào im lặng. */}
      <IssueList
        issues={errors.all.filter(
          (i) => typeof i.path === 'string' && i.path.startsWith('hierarchyProfile'),
        )}
      />
    </section>
  );
}

function DimensionPicker({
  label,
  dim,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly dim: HierarchyProfile['signboard']['row'];
  readonly disabled: boolean;
  readonly onChange: (dim: HierarchyProfile['signboard']['row']) => void;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="row">
        <select
          className="input"
          value={dim.source}
          disabled={disabled}
          aria-label={`${label} source`}
          onChange={(e) => {
            const source = e.target.value as SbDimensionSource;
            // Đổi nguồn thì gợi ý ref hợp lý thay vì giữ giá trị chắc chắn sai.
            onChange({ source, ref: source === 'TITLE_SLOT' ? 'function' : 'components' });
          }}
        >
          <option value="TITLE_SLOT">A slot in the leaf title</option>
          <option value="FIELD">A Jira field</option>
        </select>
        {dim.source === 'TITLE_SLOT' ? (
          <select
            className="input"
            value={dim.ref}
            disabled={disabled}
            aria-label={`${label} slot`}
            onChange={(e) => onChange({ ...dim, ref: e.target.value })}
          >
            {TITLE_SLOTS.map((s) => (
              <option key={s} value={s}>
                {`{${s}}`}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            value={dim.ref}
            disabled={disabled}
            aria-label={`${label} field`}
            placeholder="labels / components / customfield_…"
            onChange={(e) => onChange({ ...dim, ref: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}
