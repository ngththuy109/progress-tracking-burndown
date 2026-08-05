import type { TitlePattern } from '@app/shared';
import type { DraftAction, DraftState, PatternField } from './draft-state.js';
import type { FieldErrorIndex } from './field-errors.js';
import { InheritNotice } from './inherit-notice.js';
import { DeleteButton, IssueList, MoveButtons } from './row-controls.js';

/**
 * Khu ① — mẫu tiêu đề, thử LẦN LƯỢT TỪ TRÊN XUỐNG (PRD §2.2.4).
 *
 * Thứ tự ở đây có nghĩa thật: mẫu đầu tiên khớp là dừng. Vì vậy phải nói rõ
 * bằng chữ, không chỉ dựa vào việc PM tự đoán ra từ vị trí trên màn hình.
 */
export interface PatternSectionProps {
  readonly field: PatternField;
  readonly title: string;
  readonly hint: string;
  readonly state: DraftState;
  readonly errors: FieldErrorIndex;
  readonly dispatch: (action: DraftAction) => void;
}

export function TitlePatternsSection({
  field,
  title,
  hint,
  state,
  errors,
  dispatch,
}: PatternSectionProps) {
  const patterns: readonly TitlePattern[] = state.draft[field];
  const disabled = state.projectKey !== null && state.inherited[field];

  return (
    <section className="panel" aria-labelledby={`${field}-title`}>
      <h2 className="panel__title" id={`${field}-title`}>
        {title}
      </h2>
      <p className="panel__hint">{hint}</p>

      <InheritNotice
        part={field}
        partLabel={title}
        inherited={state.inherited[field]}
        projectKey={state.projectKey}
        onOverride={(part) => dispatch({ type: 'OVERRIDE_PART', part })}
      />

      <ul className="rows">
        {patterns.map((pattern, index) => (
          <li className="row" key={index}>
            <MoveButtons
              label={`pattern ${index + 1}`}
              index={index}
              total={patterns.length}
              onMove={(delta) => dispatch({ type: 'MOVE_PATTERN', field, index, delta })}
            />
            <input
              className="input input--wide"
              value={pattern.patternText}
              disabled={disabled}
              aria-label={`Title pattern ${index + 1}`}
              onChange={(e) =>
                dispatch({ type: 'UPDATE_PATTERN', field, index, patternText: e.target.value })
              }
            />
            <DeleteButton
              label={`pattern ${index + 1}`}
              onClick={() => dispatch({ type: 'REMOVE_PATTERN', field, index })}
            />
            <IssueList issues={errors.atRow(field, index)} />
          </li>
        ))}
      </ul>

      {patterns.length === 0 && <p className="muted">No patterns yet.</p>}

      <button type="button" className="button" onClick={() => dispatch({ type: 'ADD_PATTERN', field })}>
        + Add pattern
      </button>

      <IssueList issues={errors.at(field)} />

      {field === 'titlePatterns' && (
        <label className="check">
          <input
            type="checkbox"
            checked={state.draft.fallbackScanFullTitle}
            onChange={(e) => dispatch({ type: 'SET_FALLBACK', value: e.target.checked })}
          />
          If no pattern matches → search for keywords across the whole title
        </label>
      )}
    </section>
  );
}
