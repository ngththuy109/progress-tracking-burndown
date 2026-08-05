import { useReducer, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SignboardColumn } from '@app/shared';
import { useEffectiveConfig, useSaveConfig } from '../../api/use-phase-config.js';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/ui/index.js';
import {
  draftReducer,
  isDirty,
  loadDraft,
  payloadToSave,
  type DraftState,
} from '../config-phase/draft-state.js';
import { indexIssues, issuesOf, NO_ISSUES } from '../config-phase/field-errors.js';
import { InheritNotice } from '../config-phase/inherit-notice.js';
import { DeleteButton, IssueList, MoveButtons } from '../config-phase/row-controls.js';

/**
 * Màn hình cấu hình cột Signboard.
 *
 * DÙNG LẠI TOÀN BỘ bộ máy của T-21: cùng reducer, cùng cách neo lỗi, cùng luồng
 * lưu, cùng quy tắc kế thừa. Dựng riêng một luồng lưu thứ hai là tự tạo ra hai
 * chỗ để sai.
 */
export function SignboardColumnScreen() {
  const [params, setParams] = useSearchParams();
  const projectKey = params.get('project');
  const query = useEffectiveConfig(projectKey);

  if (query.isPending) return <LoadingState label="Loading column settings…" rows={3} />;
  if (query.isError) {
    return (
      <ErrorState error={query.error} title="Could not load column settings" onRetry={() => void query.refetch()} />
    );
  }

  return (
    <div className="stack">
      <div className="scope">
        <span className="scope__label">Scope:</span>
        <button
          type="button"
          className={`button${projectKey === null ? ' button--primary' : ''}`}
          onClick={() => setParams({})}
        >
          Default
        </button>
        {projectKey !== null && <code>{projectKey}</code>}
      </div>

      <ColumnEditor key={projectKey ?? 'GLOBAL'} config={query.data} suggested={params.get('add')} />
    </div>
  );
}

function ColumnEditor({
  config,
  suggested,
}: {
  readonly config: Parameters<typeof loadDraft>[0];
  /** Mã cột được gợi ý từ màn hình Signboard (T-31). */
  readonly suggested: string | null;
}) {
  const [state, dispatch] = useReducer(draftReducer, config, (c) => {
    const base = loadDraft(c);
    // Sang đây từ nút "thêm cột này" thì điền sẵn mã, PM khỏi gõ lại và khỏi gõ
    // sai chính tả.
    return suggested === null ? base : draftReducer(base, { type: 'ADD_COLUMN', taskCode: suggested });
  });
  const [note, setNote] = useState('');
  const save = useSaveConfig();

  const columns = state.draft.signboardColumns;
  const disabled = state.projectKey !== null && state.inherited.signboardColumns;
  const errors = save.isError ? indexIssues(issuesOf(save.error)) : NO_ISSUES;

  return (
    <>
      <section className="panel" aria-labelledby="columns-title">
        <h2 className="panel__title" id="columns-title">
          ④ Signboard columns
        </h2>
        <p className="panel__hint">
          A column code matches the <code>TaskName</code> part of a sub-task title{' '}
          <strong>exactly</strong> — <code>Create</code> does not match <code>CreateDocument</code>.
          The order here is the column order on the board.
        </p>

        <InheritNotice
          part="signboardColumns"
          partLabel="Signboard columns"
          inherited={state.inherited.signboardColumns}
          projectKey={state.projectKey}
          onOverride={(part) => dispatch({ type: 'OVERRIDE_PART', part })}
        />

        <ul className="rows">
          {columns.map((col, index) => (
            <ColumnRow
              key={index}
              col={col}
              index={index}
              total={columns.length}
              disabled={disabled}
              errors={errors.atRow('signboardColumns', index)}
              dispatch={dispatch}
            />
          ))}
        </ul>

        {columns.length === 0 && (
          <EmptyState
            title="No columns yet"
            description="With no columns the Signboard is empty — add at least one."
          />
        )}

        <button type="button" className="button" onClick={() => dispatch({ type: 'ADD_COLUMN' })}>
          + Add column
        </button>

        <IssueList issues={errors.at('signboardColumns')} />
      </section>

      <PreviewPanel state={state} />

      <section className="panel">
        <label className="field">
          <span>Note for this change</span>
          <input
            className="input input--wide"
            value={note}
            placeholder="For example: added the Deploy column"
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
        <ErrorState error={save.error} title="Could not save column settings" />
      )}
      {errors.hasBlocking && (
        <p className="notice notice--error" role="alert">
          The settings are not valid, so <strong>nothing was saved</strong>. See the red messages
          under the highlighted rows.
        </p>
      )}

      <div className="actions actions--sticky">
        <span className="muted">{isDirty(state) ? 'Unsaved changes' : 'No changes'}</span>
        <button
          type="button"
          className="button button--primary"
          disabled={!isDirty(state) || save.isPending}
          onClick={() =>
            save.mutate(
              {
                projectKey: state.projectKey,
                // Phần còn kế thừa vẫn gửi MẢNG RỖNG — cùng quy tắc với T-21.
                payload: payloadToSave(state),
                note: note === '' ? null : note,
              },
              { onSuccess: () => dispatch({ type: 'COMMIT' }) },
            )
          }
        >
          {save.isPending ? 'Saving…' : '💾 Save columns'}
        </button>
      </div>
    </>
  );
}

function ColumnRow({
  col,
  index,
  total,
  disabled,
  errors,
  dispatch,
}: {
  readonly col: SignboardColumn;
  readonly index: number;
  readonly total: number;
  readonly disabled: boolean;
  readonly errors: Parameters<typeof IssueList>[0]['issues'];
  readonly dispatch: (a: Parameters<typeof draftReducer>[1]) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const name = col.taskCode === '' ? `column ${index + 1}` : col.taskCode;

  return (
    <li className="row">
      <MoveButtons
        label={name}
        index={index}
        total={total}
        onMove={(delta) => dispatch({ type: 'MOVE_COLUMN', index, delta })}
      />
      <input
        className="input input--code"
        value={col.taskCode}
        disabled={disabled}
        aria-label={`Column code, row ${index + 1}`}
        onChange={(e) => dispatch({ type: 'UPDATE_COLUMN', index, patch: { taskCode: e.target.value } })}
      />
      <input
        className="input"
        value={col.labelVi}
        disabled={disabled}
        aria-label={`Vietnamese label, row ${index + 1}`}
        onChange={(e) => dispatch({ type: 'UPDATE_COLUMN', index, patch: { labelVi: e.target.value } })}
      />
      <input
        className="input"
        value={col.labelJa ?? ''}
        disabled={disabled}
        aria-label={`Japanese label, row ${index + 1}`}
        onChange={(e) =>
          dispatch({
            type: 'UPDATE_COLUMN',
            index,
            patch: { labelJa: e.target.value === '' ? null : e.target.value },
          })
        }
      />
      <span className="row__order muted">#{col.displayOrder}</span>

      {confirming ? (
        <span className="confirm confirm--inline" role="alertdialog" aria-label="Confirm deleting this column">
          Delete column <strong>{name}</strong>? Sub-tasks using this step will{' '}
          <strong>drop off the Signboard</strong> (they still count towards Burndown).
          <button type="button" className="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => dispatch({ type: 'REMOVE_COLUMN', index })}
          >
            Delete anyway
          </button>
        </span>
      ) : (
        <DeleteButton label={name} onClick={() => setConfirming(true)} />
      )}

      <IssueList issues={errors} />
    </li>
  );
}

/**
 * Xem thử riêng cho cột.
 *
 * Dán vài tiêu đề Sub-task mẫu rồi xem chúng vào cột nào — khớp CHÍNH XÁC nên
 * kiểm được ngay tại chỗ, không cần gọi máy chủ.
 */
function PreviewPanel({ state }: { readonly state: DraftState }) {
  const [raw, setRaw] = useState('');

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

  const codes = state.draft.signboardColumns.map((c) => c.taskCode);

  return (
    <section className="panel" aria-labelledby="preview-columns-title">
      <h2 className="panel__title" id="preview-columns-title">
        Preview
      </h2>
      <p className="panel__hint">
        Paste a few sub-task titles, one per line, to see which column each one lands in.
      </p>
      <label className="field">
        <span>Sample titles</span>
        <input
          className="input input--wide"
          value={raw}
          placeholder="[PAY][TeamA][Design][Login]_Create"
          aria-label="Sample titles"
          onChange={(e) => setRaw(e.target.value)}
        />
      </label>

      <ul className="rows">
        {lines.map((line, i) => {
          const taskName = line.slice(line.lastIndexOf('_') + 1).trim();
          const matched = codes.includes(taskName);
          return (
            <li className="row" key={i}>
              <code>{line}</code>
              {matched ? (
                <Badge tone="success">goes to column {taskName}</Badge>
              ) : (
                <Badge tone="warning">
                  falls off the board — TaskName &ldquo;{taskName}&rdquo; matches no column
                </Badge>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
