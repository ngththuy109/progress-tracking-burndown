import type { DraftAction, DraftState } from './draft-state.js';
import type { FieldErrorIndex } from './field-errors.js';
import { InheritNotice } from './inherit-notice.js';
import { DeleteButton, IssueList, MoveButtons } from './row-controls.js';

/**
 * Khu ② — danh sách Phase.
 *
 * Thứ tự ở khu này là **`display_order`: thứ tự HIỆN trên biểu đồ**. Nó KHÁC
 * `match_priority` ở khu ③ (ưu tiên khi khớp từ khoá). PRD §2.2.3 dành hẳn một
 * mục để tách bạch hai khái niệm, nên nhãn trên màn hình phải nói thẳng ra —
 * gộp hai thứ này trong đầu PM là dẫn thẳng tới hiểu nhầm nghiệp vụ.
 */
export const PHASE_ORDER_HINT =
  'Reordering here changes the DISPLAY ORDER on the chart (display_order). It does not affect which Task lands in which Phase.';

export interface PhaseSectionProps {
  readonly state: DraftState;
  readonly errors: FieldErrorIndex;
  readonly dispatch: (action: DraftAction) => void;
}

export function PhaseDefinitionsSection({ state, errors, dispatch }: PhaseSectionProps) {
  const phases = state.draft.phaseDefinitions;
  const disabled = state.projectKey !== null && state.inherited.phaseDefinitions;

  return (
    <section className="panel" aria-labelledby="phases-title">
      <h2 className="panel__title" id="phases-title">
        ② Phase list
      </h2>
      <p className="panel__hint">{PHASE_ORDER_HINT}</p>

      <InheritNotice
        part="phaseDefinitions"
        partLabel="Phase list"
        inherited={state.inherited.phaseDefinitions}
        projectKey={state.projectKey}
        onOverride={(part) => dispatch({ type: 'OVERRIDE_PART', part })}
      />

      <ul className="rows">
        {phases.map((phase, index) => {
          const name = phase.phaseCode === '' ? `Phase ${index + 1}` : phase.phaseCode;
          return (
            <li className="row" key={index}>
              <MoveButtons
                label={name}
                index={index}
                total={phases.length}
                onMove={(delta) => dispatch({ type: 'MOVE_PHASE', index, delta })}
              />
              <input
                className="input input--code"
                value={phase.phaseCode}
                disabled={disabled}
                aria-label={`Phase code, row ${index + 1}`}
                onChange={(e) =>
                  dispatch({ type: 'UPDATE_PHASE', index, patch: { phaseCode: e.target.value } })
                }
              />
              <input
                className="input"
                value={phase.labelVi}
                disabled={disabled}
                aria-label={`Vietnamese label, row ${index + 1}`}
                onChange={(e) =>
                  dispatch({ type: 'UPDATE_PHASE', index, patch: { labelVi: e.target.value } })
                }
              />
              <input
                className="input"
                value={phase.labelJa ?? ''}
                disabled={disabled}
                aria-label={`Japanese label, row ${index + 1}`}
                onChange={(e) =>
                  dispatch({
                    type: 'UPDATE_PHASE',
                    index,
                    // Ô rỗng nghĩa là "chưa đặt" — lưu `null`, không lưu chuỗi rỗng.
                    patch: { labelJa: e.target.value === '' ? null : e.target.value },
                  })
                }
              />
              <input
                type="color"
                className="input input--color"
                value={phase.colorHex ?? '#4A90D9'}
                disabled={disabled}
                aria-label={`Colour, row ${index + 1}`}
                onChange={(e) =>
                  dispatch({ type: 'UPDATE_PHASE', index, patch: { colorHex: e.target.value } })
                }
              />
              <span className="row__order muted" aria-label={`Display order, row ${index + 1}`}>
                #{phase.displayOrder}
              </span>
              <DeleteButton label={name} onClick={() => dispatch({ type: 'REMOVE_PHASE', index })} />
              <IssueList issues={errors.atRow('phaseDefinitions', index)} />
            </li>
          );
        })}
      </ul>

      {phases.length === 0 && <p className="muted">No Phases yet.</p>}

      <button type="button" className="button" onClick={() => dispatch({ type: 'ADD_PHASE' })}>
        + Add Phase
      </button>

      <IssueList issues={errors.at('phaseDefinitions')} />
    </section>
  );
}
