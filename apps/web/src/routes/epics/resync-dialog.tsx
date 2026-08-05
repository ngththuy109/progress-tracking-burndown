import { useState } from 'react';
import { useResyncEpic } from '../../api/use-ops.js';
import { ErrorState } from '../../components/ui/index.js';
import {
  draftError,
  draftToPayload,
  EMPTY_DRAFT,
  RESYNC_MODES,
  type ResyncDraft,
  type ResyncMode,
} from './resync-modes.js';

/**
 * Hộp chọn mức đồng bộ lại.
 *
 * VÌ SAO PHẢI CÓ HỘP THOẠI CHỨ KHÔNG PHẢI MỘT NÚT: ba mức chênh nhau gần mười
 * lần về số request gửi sang Jira. Một nút duy nhất thì hoặc là quá rẻ để sửa
 * được sự cố thật, hoặc là quá đắt để bấm hằng ngày. Runbook mô tả ba mức, và
 * người dùng phải chọn được đủ ba mức đó mà không cần mở dòng lệnh.
 */
export interface ResyncDialogProps {
  readonly epic: { readonly epicKey: string; readonly displayName: string };
  readonly onClose: () => void;
}

export function ResyncDialog({ epic, onClose }: ResyncDialogProps) {
  const [draft, setDraft] = useState<ResyncDraft>(EMPTY_DRAFT);
  const resync = useResyncEpic();

  const error = draftError(draft);
  const setMode = (mode: ResyncMode) => setDraft((d) => ({ ...d, mode }));

  return (
    <div className="confirm" role="dialog" aria-label="Choose resync depth">
      <p>
        Resync <strong>{epic.epicKey}</strong> ({epic.displayName}).
      </p>

      <fieldset className="field">
        <legend>How much to rebuild</legend>
        {RESYNC_MODES.map((m) => (
          <label className="choice" key={m.mode}>
            {/* Tên dùng cho trình đọc màn hình phải NGẮN VÀ DUY NHẤT.
                Để nó là cả câu mô tả thì "Nhanh" xuất hiện trong cả nhãn mức
                Nhanh lẫn mô tả mức Toàn bộ ("chỉ dùng khi mức Nhanh không sửa
                được") — chọn theo tên sẽ dính hai phần tử. Phần mô tả nối vào
                bằng `aria-describedby` nên vẫn đọc được đầy đủ. */}
            <input
              type="radio"
              name="resync-mode"
              value={m.mode}
              aria-label={`${m.mode === 'QUICK' ? 'Quick' : m.mode === 'FULL' ? 'Full' : 'Date range'} rebuild`}
              aria-describedby={`resync-mode-${m.mode}`}
              checked={draft.mode === m.mode}
              onChange={() => setMode(m.mode)}
            />
            <span id={`resync-mode-${m.mode}`}>
              <strong>{m.label}</strong>
              <span className="muted"> — {m.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {draft.mode === 'RANGE' && (
        <div className="row">
          {/* KHÔNG thêm `aria-label` trùng với chữ trong `<span>`: ô nhập sẽ có
              hai nguồn nhãn giống hệt nhau và bị tìm thấy hai lần. */}
          <label className="field">
            <span>From</span>
            <input
              className="input"
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              className="input"
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            />
          </label>
        </div>
      )}

      {/* Cảnh báo chỉ hiện khi thật sự tốn kém. Hiện ở mọi mức thì nó thành thứ
          ai cũng lướt qua, và lúc cần cảnh báo thì không ai đọc nữa. */}
      {draft.mode === 'FULL' && (
        <p className="notice notice--warning" role="note">
          This uses the <strong>shared Jira rate limit</strong> while it runs, so other Epics sync
          more slowly. Try Quick first.
        </p>
      )}

      {error !== null && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      {resync.isError && <ErrorState error={resync.error} title="Could not queue the sync job" />}

      {resync.isSuccess ? (
        <p className="notice notice--ok" role="status">
          Queued. Follow its progress on the Monitoring screen.
        </p>
      ) : null}

      <div className="actions">
        <button type="button" className="button" onClick={onClose}>
          {resync.isSuccess ? 'Close' : 'Cancel'}
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={error !== null || resync.isPending || resync.isSuccess}
          onClick={() => resync.mutate({ epicKey: epic.epicKey, body: draftToPayload(draft) })}
        >
          {resync.isPending ? 'Queueing…' : 'Resync'}
        </button>
      </div>
    </div>
  );
}
