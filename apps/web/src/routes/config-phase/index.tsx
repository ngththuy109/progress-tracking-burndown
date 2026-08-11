import { useMemo, useReducer, useState } from 'react';
import type { EffectiveConfigResponse } from '@app/shared';
import { usePreview, useSaveConfig, useEffectiveConfig } from '../../api/use-phase-config.js';
import { useProject } from '../../project/project-context.js';
import { Badge, ErrorState, LoadingState } from '../../components/ui/index.js';
import {
  draftReducer,
  isDirty,
  loadDraft,
  payloadToPreview,
  payloadToSave,
} from './draft-state.js';
import { validateDraftClient } from './client-validation.js';
import { indexIssues, issuesOf, NO_ISSUES } from './field-errors.js';
import { MatchRulesSection } from './match-rules-section.js';
import { PhaseDefinitionsSection } from './phase-definitions-section.js';
import { PreviewPanel } from './preview-panel.js';
import { ScopePicker } from './scope-picker.js';
import { TitlePatternsSection } from './title-patterns-section.js';
import { UnmatchedPanel } from './unmatched-panel.js';
import { VersionsPanel } from './versions-panel.js';

/**
 * Màn hình quản trị cấu hình nhận diện Phase — PRD §2.2.4 → §2.2.7.
 *
 * PM tự sửa quy tắc, xem trước kết quả trên Task thật, rồi mới lưu — không cần
 * dev, không cần deploy. Đây là màn hình làm giảm rủi ro R-01.
 *
 * Toàn bộ thao tác sửa chỉ đổi trạng thái nháp ở client (`draft-state.ts`).
 * Chỉ hai nút gọi API: **Xem thử** và **Lưu**.
 */
export function ConfigPhaseScreen() {
  // Mặc định sửa cấu hình CỦA DỰ ÁN ĐANG MỞ; ADMIN có thể chuyển sang bộ Mặc
  // định (GLOBAL, `projectKey = null`) bằng ScopePicker.
  const scope = useProject();
  const [projectKey, setProjectKey] = useState<string | null>(scope.projectKey);
  const [tab, setTab] = useState<'config' | 'history'>('config');

  const query = useEffectiveConfig(projectKey);

  return (
    <div className="stack">
      <ScopePicker projectKey={projectKey} onChange={setProjectKey} dirty={false} />

      <div className="tabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'config'}
          className={`tab${tab === 'config' ? ' tab--active' : ''}`}
          onClick={() => setTab('config')}
        >
          Settings
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={`tab${tab === 'history' ? ' tab--active' : ''}`}
          onClick={() => setTab('history')}
        >
          History
        </button>
      </div>

      {tab === 'history' ? (
        <VersionsPanel projectKey={projectKey} />
      ) : query.isPending ? (
        <LoadingState label="Loading Phase matching settings…" rows={4} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          title="Could not load Phase settings"
          onRetry={() => void query.refetch()}
        />
      ) : (
        // Đổi phạm vi thì dựng lại từ đầu — cấu hình khác hẳn, không có gì để
        // giữ lại. Cùng một phạm vi thì KHÔNG dựng lại, kể cả khi tải ngầm lại
        // dữ liệu: làm vậy sẽ xoá sạch phần PM đang gõ dở mà không báo gì.
        <ConfigEditor key={projectKey ?? 'GLOBAL'} config={query.data} />
      )}
    </div>
  );
}

interface ConfigEditorProps {
  readonly config: EffectiveConfigResponse;
}

function ConfigEditor({ config }: ConfigEditorProps) {
  const [state, dispatch] = useReducer(draftReducer, config, loadDraft);
  const [note, setNote] = useState('');
  /** Bản nháp đã được xem thử. Khác bản hiện tại nghĩa là kết quả đã cũ. */
  const [previewedOf, setPreviewedOf] = useState<string | null>(null);
  const [forceSave, setForceSave] = useState(false);
  /**
   * Đã bấm Lưu/Xem thử lần nào chưa. Chỉ hiện lỗi kiểm-tại-client SAU khi đã thử —
   * bật đỏ ngay lúc PM vừa bấm "+ Add Phase" (dòng còn trống là đương nhiên) thì
   * phiền và bị hiểu là màn hình lỗi. Sau lần thử đầu thì cập nhật realtime: sửa
   * xong ô nào, lỗi dòng đó biến mất ngay.
   */
  const [attempted, setAttempted] = useState(false);

  const preview = usePreview();
  const save = useSaveConfig();

  const dirty = isDirty(state);
  const draftKey = JSON.stringify(payloadToPreview(state));
  const previewIsFresh = preview.isSuccess && previewedOf === draftKey;

  // Lỗi hình dạng kiểm ngay tại client (ô bắt buộc còn trống) — cho phản hồi tức
  // thì, không phải chờ máy chủ trả 400. Chỉ tính sau khi PM đã thử Lưu/Xem thử.
  const clientIssues = useMemo(
    () => (attempted ? validateDraftClient(payloadToPreview(state)) : []),
    [attempted, state],
  );

  // Gộp lỗi client (hình dạng) với lỗi máy chủ (luật nghiệp vụ như trùng mã, trỏ
  // Phase chưa định nghĩa...). Cả hai đã cùng quy ước đường dẫn nên neo chung được.
  const errors = useMemo(() => {
    const issues = [...clientIssues, ...issuesOf(save.error)];
    return issues.length === 0 ? NO_ISSUES : indexIssues(issues);
  }, [clientIssues, save.error]);

  /** Có lỗi hình dạng nào chặn việc gửi đi không (tính trên bản nháp hiện tại). */
  const hasBlockingClientErrors = (): boolean => validateDraftClient(payloadToPreview(state)).length > 0;

  const runPreview = (): void => {
    setAttempted(true);
    setForceSave(false);
    // Sai hình dạng thì hiện lỗi neo dòng ngay, KHÔNG gọi máy chủ (chắc chắn 400).
    if (hasBlockingClientErrors()) return;
    setPreviewedOf(draftKey);
    preview.mutate({ projectKey: state.projectKey, draft: payloadToPreview(state) });
  };

  /** Nút "Lưu không xem thử": chỉ mở hộp xác nhận khi cấu hình đã hợp lệ hình dạng. */
  const askSaveWithoutPreview = (): void => {
    setAttempted(true);
    // Còn ô bắt buộc trống thì hiện lỗi ngay, khỏi mở hộp xác nhận — không có gì
    // để xác nhận vì có bấm tiếp cũng không lưu được.
    if (hasBlockingClientErrors()) return;
    setForceSave(true);
  };

  const runSave = (): void => {
    setAttempted(true);
    if (hasBlockingClientErrors()) {
      setForceSave(false);
      return;
    }
    save.mutate(
      { projectKey: state.projectKey, payload: payloadToSave(state), note: note === '' ? null : note },
      {
        onSuccess: () => {
          // Lưu xong thì bản nháp CHÍNH LÀ bản trên máy chủ — hết "chưa lưu".
          dispatch({ type: 'COMMIT' });
          preview.reset();
          setPreviewedOf(null);
          setForceSave(false);
          setAttempted(false);
        },
      },
    );
  };

  if (previewIsFresh && preview.data !== undefined) {
    return (
      <PreviewPanel
        result={preview.data}
        saving={save.isPending}
        onBack={() => {
          preview.reset();
          setPreviewedOf(null);
        }}
        onConfirm={runSave}
      />
    );
  }

  return (
    <div className="stack">
      <div className="statusbar">
        <span>
          Default set{' '}
          <Badge tone="muted">
            {config.globalVersion === 0 ? 'not created yet' : `v${config.globalVersion}`}
          </Badge>
          {config.projectKey !== null && (
            <>
              {' · '}Project {config.projectKey}{' '}
              <Badge tone="muted">
                {config.projectVersion === null ? 'no own version' : `v${config.projectVersion}`}
              </Badge>
            </>
          )}
        </span>
        {dirty && (
          <Badge tone="warning" title="Click Preview, then Confirm save, to write these changes">
            Unsaved changes
          </Badge>
        )}
      </div>

      {save.isSuccess && (
        <p className="notice notice--ok" role="status">
          Saved as version v{save.data.version}. {save.data.affectedEpics} Epics will be recomputed.
        </p>
      )}

      {/* Lỗi không neo được vào trường nào — mạng hỏng, máy chủ lỗi, hoặc cảnh
          báo chung. Lỗi có `path` đã hiện ngay tại dòng gây lỗi rồi. */}
      {save.isError && errors.unanchored.length === 0 && !errors.hasBlocking && (
        <ErrorState error={save.error} title="Could not save settings" onRetry={runSave} />
      )}
      {errors.unanchored.length > 0 && (
        <div className="notice notice--error" role="alert">
          <strong>Not saved:</strong>
          <ul>
            {errors.unanchored.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      {errors.hasBlocking && errors.unanchored.length === 0 && (
        <p className="notice notice--error" role="alert">
          The settings are not valid, so <strong>nothing was saved</strong>. See the red messages
          right under the highlighted rows.
        </p>
      )}

      {preview.isError && <ErrorState error={preview.error} title="Could not run the preview" onRetry={runPreview} />}

      <TitlePatternsSection
        field="titlePatterns"
        title="① Task title patterns"
        hint="Tried TOP TO BOTTOM; the first match wins. Use {name} as the placeholder."
        state={state}
        errors={errors}
        dispatch={dispatch}
      />

      <TitlePatternsSection
        field="subtaskPatterns"
        title="Sub-task title patterns"
        hint="Used by the Signboard. Must contain {function} and {task}."
        state={state}
        errors={errors}
        dispatch={dispatch}
      />

      <PhaseDefinitionsSection state={state} errors={errors} dispatch={dispatch} />
      <MatchRulesSection state={state} errors={errors} dispatch={dispatch} />

      <UnmatchedPanel
        projectKey={state.projectKey}
        onAddRule={(keyword) => dispatch({ type: 'ADD_RULE', keyword })}
      />

      <section className="panel">
        <label className="field">
          <span>Note for this change</span>
          <input
            className="input input--wide"
            value={note}
            placeholder="For example: moved Design Review into the Testing Phase"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <p className="muted">
          Notes show up on the History tab so the next person knows why this changed.
        </p>
      </section>

      <div className="actions actions--sticky">
        <button
          type="button"
          className="button button--primary"
          onClick={runPreview}
          disabled={preview.isPending}
        >
          {preview.isPending ? 'Running preview…' : '👁 Preview'}
        </button>

        {/*
          Lưu thẳng KHÔNG bị chặn, nhưng phải qua một bước cảnh báo.
          PRD §2.2.5 nói Xem thử là bắt buộc; chặn cứng thì PM sửa một dấu cách
          trong ghi chú cũng phải xem thử lại, nên đây là mức vừa phải.
        */}
        {forceSave ? (
          <span className="confirm confirm--inline" role="alertdialog" aria-label="Confirm saving without a preview">
            Save without previewing? You will not see which Tasks change classification.
            <button type="button" className="button" onClick={() => setForceSave(false)}>
              Cancel
            </button>
            <button type="button" className="button button--danger" onClick={runSave} disabled={save.isPending}>
              Save anyway
            </button>
          </span>
        ) : (
          <button type="button" className="button" onClick={askSaveWithoutPreview} disabled={!dirty}>
            💾 Save without preview
          </button>
        )}
      </div>
    </div>
  );
}
