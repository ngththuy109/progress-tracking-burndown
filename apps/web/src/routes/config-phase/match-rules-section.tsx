import { MATCH_MODE } from '@app/shared';
import { phaseCodeOptions, type DraftAction, type DraftState } from './draft-state.js';
import type { FieldErrorIndex } from './field-errors.js';
import { InheritNotice } from './inherit-notice.js';
import { DeleteButton, IssueList } from './row-controls.js';

/**
 * Khu ③ — luật khớp từ khoá sang Phase.
 *
 * Số ở cột cuối là **`match_priority`: ưu tiên KHI KHỚP, số nhỏ thắng trước**.
 * Nó KHÁC `display_order` ở khu ②. Không đổi thứ tự bằng nút lên/xuống ở đây,
 * mà sửa thẳng con số — vì đó mới đúng bản chất: hai luật CÙNG số ưu tiên là
 * một tình huống có thật, còn "vị trí thứ 3 trong danh sách" thì không có nghĩa
 * gì cả.
 */
export const RULE_PRIORITY_HINT =
  'Priority WHEN MATCHING (match_priority) — a lower number is tried first. This is NOT the display order on the chart.';

const MODE_LABEL: Record<(typeof MATCH_MODE)[number], string> = {
  CONTAINS: 'contains',
  REGEX: 'regex',
};

export interface MatchRulesSectionProps {
  readonly state: DraftState;
  readonly errors: FieldErrorIndex;
  readonly dispatch: (action: DraftAction) => void;
}

export function MatchRulesSection({ state, errors, dispatch }: MatchRulesSectionProps) {
  const rules = state.draft.matchRules;
  const disabled = state.projectKey !== null && state.inherited.matchRules;
  const phaseCodes = phaseCodeOptions(state);

  return (
    <section className="panel" aria-labelledby="rules-title">
      <h2 className="panel__title" id="rules-title">
        ③ Keyword matching rules
      </h2>
      <p className="panel__hint">{RULE_PRIORITY_HINT}</p>

      <InheritNotice
        part="matchRules"
        partLabel="Keyword matching rules"
        inherited={state.inherited.matchRules}
        projectKey={state.projectKey}
        onOverride={(part) => dispatch({ type: 'OVERRIDE_PART', part })}
      />

      <ul className="rows">
        {rules.map((rule, index) => {
          const name = rule.keyword === '' ? `rule ${index + 1}` : `rule "${rule.keyword}"`;
          return (
            <li className="row" key={index}>
              <input
                className="input input--wide"
                value={rule.keyword}
                disabled={disabled}
                aria-label={`Keyword, row ${index + 1}`}
                onChange={(e) =>
                  dispatch({ type: 'UPDATE_RULE', index, patch: { keyword: e.target.value } })
                }
              />
              <select
                className="input"
                value={rule.matchMode}
                disabled={disabled}
                aria-label={`Match mode, row ${index + 1}`}
                onChange={(e) =>
                  dispatch({
                    type: 'UPDATE_RULE',
                    index,
                    patch: { matchMode: e.target.value as (typeof MATCH_MODE)[number] },
                  })
                }
              >
                {MATCH_MODE.map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABEL[mode]}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={rule.phaseCode}
                disabled={disabled}
                aria-label={`Target Phase, row ${index + 1}`}
                onChange={(e) =>
                  dispatch({ type: 'UPDATE_RULE', index, patch: { phaseCode: e.target.value } })
                }
              >
                {/* Giữ lại mã đang lưu kể cả khi nó không còn trong danh sách Phase:
                    xoá luôn khỏi ô chọn thì PM không thấy chỗ sai để sửa. */}
                {!phaseCodes.includes(rule.phaseCode) && (
                  <option value={rule.phaseCode}>{rule.phaseCode || '(not set)'}</option>
                )}
                {phaseCodes.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
              <input
                type="number"
                className="input input--number"
                value={rule.matchPriority}
                disabled={disabled}
                aria-label={`Match priority, row ${index + 1}`}
                onChange={(e) =>
                  dispatch({
                    type: 'UPDATE_RULE',
                    index,
                    patch: { matchPriority: Number(e.target.value) },
                  })
                }
              />
              <DeleteButton label={name} onClick={() => dispatch({ type: 'REMOVE_RULE', index })} />
              <IssueList issues={errors.atRow('matchRules', index)} />
            </li>
          );
        })}
      </ul>

      {rules.length === 0 && <p className="muted">No rules yet.</p>}

      <button type="button" className="button" onClick={() => dispatch({ type: 'ADD_RULE' })}>
        + Add rule
      </button>

      <IssueList issues={errors.at('matchRules')} />
    </section>
  );
}
