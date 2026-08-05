import { useState } from 'react';
import { useRemoveEpic } from '../../api/use-epics.js';
import { ErrorState } from '../../components/ui/index.js';

/**
 * Hộp xác nhận bỏ theo dõi Epic.
 *
 * BẮT GÕ LẠI MÃ EPIC. Nghe phiền, nhưng đây là thao tác DUY NHẤT trong sản phẩm
 * không hoàn tác được: toàn bộ snapshot và lịch sử của Epic bị xoá, muốn có lại
 * phải chạy bù từ đầu (PRD §2.6.4).
 *
 * Một hộp thoại chỉ có nút "Đồng ý" là chưa đủ cho việc đó.
 */
export interface RemoveEpicDialogProps {
  readonly epic: { readonly epicKey: string; readonly displayName: string };
  readonly onClose: () => void;
}

export function RemoveEpicDialog({ epic, onClose }: RemoveEpicDialogProps) {
  const [typed, setTyped] = useState('');
  const remove = useRemoveEpic();

  const matches = typed.trim() === epic.epicKey;

  return (
    <div className="confirm" role="alertdialog" aria-label="Confirm untracking this Epic">
      <p>
        Untracking <strong>{epic.epicKey}</strong> ({epic.displayName}) <strong>deletes all</strong>{' '}
        its history and snapshots. This <strong>cannot be undone</strong> — getting it back means
        adding the Epic again and waiting for the history to rebuild from scratch.
      </p>
      <p className="muted">
        Just want to stop syncing but keep the data? Use <em>Pause</em> instead.
      </p>

      <label className="field">
        <span>
          Type <code>{epic.epicKey}</code> to confirm
        </span>
        <input
          className="input input--code"
          value={typed}
          aria-label="Type the Epic key to confirm"
          onChange={(e) => setTyped(e.target.value)}
        />
      </label>

      {remove.isError && <ErrorState error={remove.error} title="Could not untrack this Epic" />}

      <div className="actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button button--danger"
          disabled={!matches || remove.isPending}
          onClick={() =>
            remove.mutate(
              { epicKey: epic.epicKey, purge: true, confirmKey: epic.epicKey },
              { onSuccess: onClose },
            )
          }
        >
          {remove.isPending ? 'Deleting…' : 'Delete permanently'}
        </button>
      </div>
    </div>
  );
}
