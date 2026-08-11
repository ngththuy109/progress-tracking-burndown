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
  phaseCodeOptions,
  subPhaseGroups,
  type DraftAction,
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

      <ColumnEditor
        key={projectKey ?? 'GLOBAL'}
        config={query.data}
        suggested={params.get('add')}
        orderPhase={params.get('orderPhase')}
        orderSubs={params.get('subs')}
      />
    </div>
  );
}

/** So khoá kiểu E-31 — bản nhẹ phía web, đủ để nhận ra nhóm đã tồn tại. */
const groupKey = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function ColumnEditor({
  config,
  suggested,
  orderPhase,
  orderSubs,
}: {
  readonly config: Parameters<typeof loadDraft>[0];
  /** Mã cột được gợi ý từ màn hình Signboard (T-31). */
  readonly suggested: string | null;
  /** Phase được màn hình Signboard gửi sang để khai thứ tự Sub-phase. */
  readonly orderPhase: string | null;
  /** Danh sách Sub-phase ĐANG CÓ trên bảng của Phase đó, phân tách bằng dấu phẩy. */
  readonly orderSubs: string | null;
}) {
  const [state, dispatch] = useReducer(draftReducer, config, (c) => {
    let base = loadDraft(c);
    // Sang đây từ nút "thêm cột này" thì điền sẵn mã, PM khỏi gõ lại và khỏi gõ
    // sai chính tả.
    if (suggested !== null) base = draftReducer(base, { type: 'ADD_COLUMN', taskCode: suggested });
    // Sang từ nút "xếp thứ tự Sub-phase": điền sẵn CẢ NHÓM với đúng các Sub-phase
    // đang hiện trên bảng — PM chỉ việc bấm mũi tên, không phải gõ lại mã nào.
    // Phase đã có nhóm thì thôi, không nhân đôi.
    if (
      orderPhase !== null &&
      orderPhase !== '' &&
      !base.draft.subPhaseOrders.some((r) => groupKey(r.phaseCode) === groupKey(orderPhase))
    ) {
      const subs = (orderSubs ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      base = draftReducer(base, {
        type: 'ADD_SUB_PHASE_GROUP',
        phaseCode: orderPhase,
        subPhaseCodes: subs.length > 0 ? subs : [''],
      });
    }
    return base;
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

      <SubPhaseOrderSection state={state} errors={errors} dispatch={dispatch} />

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
      {/* Phía làm loại task này — quyết định ngày kế hoạch của Sub-task được
          kiểm tra với lịch nghỉ VN hay JP (T-37). */}
      <select
        className="input"
        value={col.side}
        disabled={disabled}
        aria-label={`Side, row ${index + 1}`}
        onChange={(e) =>
          dispatch({ type: 'UPDATE_COLUMN', index, patch: { side: e.target.value as 'VN' | 'JP' } })
        }
      >
        <option value="VN">VN does</option>
        <option value="JP">JP does</option>
      </select>
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
 * Khu ⑤ — thứ tự Sub-phase TRONG TỪNG PHASE trên bảng Signboard.
 *
 * Đây là CHỖ SETTING RIÊNG mà khu ② Phase list không đảm nhiệm: ② xếp thứ tự
 * các PHASE trên biểu đồ, còn ở đây xếp thứ tự các NHÓM CỘT Sub-phase khi mở
 * MỘT Phase trên Signboard. Phase không có Sub-phase thì không cần khai gì —
 * bảng của nó chỉ có một nhóm, không có thứ tự nào để chỉnh.
 */
function SubPhaseOrderSection({
  state,
  errors,
  dispatch,
}: {
  readonly state: DraftState;
  readonly errors: ReturnType<typeof indexIssues>;
  readonly dispatch: (a: DraftAction) => void;
}) {
  const groups = subPhaseGroups(state);
  const disabled = state.projectKey !== null && state.inherited.subPhaseOrders;
  // Danh sách Phase ĐÃ ĐỊNH NGHĨA ở khu ② — để ô Phase là ô CHỌN, không cho gõ
  // tay mã sai chính tả. Cùng nguồn, cùng cách với ô chọn Phase ở khu ③.
  const phaseCodes = phaseCodeOptions(state);

  return (
    <section className="panel" aria-labelledby="sub-phase-order-title">
      <h2 className="panel__title" id="sub-phase-order-title">
        ⑤ Sub-phase order
      </h2>
      <p className="panel__hint">
        When a Phase has several sub-phases (the <code>[Sub-phase]</code> bracket right before the
        Function name), this is the order of the sub-phase column groups on its Signboard. Only
        declare Phases that actually have sub-phases. A sub-phase code matches after
        normalisation, so <code>FUT_TC</code> and <code>fut_tc</code> are the same. Sub-phases not
        listed here fall back to the old rule: match a Phase&rsquo;s code → that Phase&rsquo;s
        order, otherwise A→Z, with &ldquo;(No sub-phase)&rdquo; always last.
      </p>

      <InheritNotice
        part="subPhaseOrders"
        partLabel="Sub-phase order"
        inherited={state.inherited.subPhaseOrders}
        projectKey={state.projectKey}
        onOverride={(part) => dispatch({ type: 'OVERRIDE_PART', part })}
      />

      {groups.map((group, gi) => (
        // Key theo dòng ĐẦU của nhóm, KHÔNG theo mã Phase: mã Phase là khoá
        // nhóm, đổi khi PM chọn Phase khác — key đổi theo thì cả khối bị dựng lại.
        <div className="stack" key={group.rows[0]?.index ?? gi}>
          <label className="field">
            <span>Phase</span>
            <select
              className="input input--code"
              value={group.phaseCode}
              disabled={disabled}
              aria-label={`Phase of sub-phase group ${gi + 1}`}
              onChange={(e) =>
                dispatch({
                  type: 'RENAME_SUB_PHASE_GROUP',
                  phaseCode: group.phaseCode,
                  value: e.target.value,
                })
              }
            >
              {/* Nhóm mới (chưa chọn) hoặc mã Phase không còn trong danh sách ②
                  vẫn phải hiện ra: ẩn đi thì PM không thấy nhóm sai để sửa. Cùng
                  cách giữ lại giá trị đang có như ô chọn Phase ở khu ③. */}
              {!phaseCodes.includes(group.phaseCode) && (
                <option value={group.phaseCode}>
                  {group.phaseCode === '' ? '(select a Phase)' : group.phaseCode}
                </option>
              )}
              {phaseCodes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          <ul className="rows">
            {group.rows.map(({ row, index }, groupIndex) => {
              const name = row.subPhaseCode === '' ? `sub-phase ${groupIndex + 1}` : row.subPhaseCode;
              return (
                <li className="row" key={index}>
                  <MoveButtons
                    label={name}
                    index={groupIndex}
                    total={group.rows.length}
                    onMove={(delta) => dispatch({ type: 'MOVE_SUB_PHASE', index, delta })}
                  />
                  <input
                    className="input input--code"
                    value={row.subPhaseCode}
                    disabled={disabled}
                    aria-label={`Sub-phase code, ${group.phaseCode || 'new Phase'} row ${groupIndex + 1}`}
                    onChange={(e) =>
                      dispatch({ type: 'UPDATE_SUB_PHASE', index, subPhaseCode: e.target.value })
                    }
                  />
                  <span className="row__order muted">#{row.displayOrder}</span>
                  <DeleteButton label={name} onClick={() => dispatch({ type: 'REMOVE_SUB_PHASE', index })} />
                  <IssueList issues={errors.atRow('subPhaseOrders', index)} />
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => dispatch({ type: 'ADD_SUB_PHASE', phaseCode: group.phaseCode })}
          >
            + Add sub-phase to {group.phaseCode === '' ? 'this Phase' : group.phaseCode}
          </button>
        </div>
      ))}

      {groups.length === 0 && (
        <p className="muted">
          No sub-phase order declared yet — every board keeps the fallback order. The easiest way
          to start is the &ldquo;Set sub-phase order&rdquo; link on a Signboard that shows several
          sub-phase groups: it opens this screen with that Phase pre-filled.
        </p>
      )}

      <button
        type="button"
        className="button"
        disabled={disabled}
        onClick={() => dispatch({ type: 'ADD_SUB_PHASE_GROUP', phaseCode: '', subPhaseCodes: [''] })}
      >
        + Add Phase group
      </button>

      <IssueList issues={errors.at('subPhaseOrders')} />
    </section>
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
