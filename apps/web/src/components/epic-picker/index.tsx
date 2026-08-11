import { Link } from 'react-router-dom';
import type { TrackedEpicSummary } from '@app/shared';
import { useEpicList } from '../../api/use-epics.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/index.js';

/**
 * Bộ chọn Epic dùng chung cho Burndown, Signboard và Phase sub-tasks.
 *
 * Ba màn hình đó đọc Epic từ URL (`?epic=KEY`). Khi người dùng bấm vào từ thanh
 * bên — không kèm Epic — trước đây chỉ hiện một ô trống bảo "sang màn Epics".
 * Đó là ngõ cụt: phải rời màn hình, tìm Epic, rồi bấm nút tương ứng để quay lại.
 *
 * Bộ chọn này thay ô trống đó bằng danh sách Epic đang ACTIVE — kèm MÃ ticket và
 * TIÊU ĐỀ để dễ nhận ra — bấm một cái là nạp dữ liệu ngay tại chỗ.
 */

/**
 * "Active" = đang theo dõi thật sự.
 *
 * Chỉ Epic ở trạng thái `ACTIVE` mới đã dựng xong lịch sử để vẽ. Các trạng thái
 * khác cố ý bị loại: `PENDING`/`BACKFILLING` chưa có đủ số liệu, `PAUSED` đã
 * ngừng đồng bộ, `ERROR` đang hỏng — chọn chúng ở đây chỉ dẫn tới màn hình rỗng.
 */
function isActive(epic: TrackedEpicSummary): boolean {
  return epic.status === 'ACTIVE';
}

export interface EpicPickerProps {
  /** Biểu tượng của màn hình gọi tới — giữ đúng "vị trí" cho người dùng. */
  readonly icon: string;
  readonly title: string;
  readonly description: string;
  /** Gọi khi chọn một Epic; màn hình tự ghi lựa chọn vào URL. */
  readonly onSelect: (epicKey: string) => void;
}

export function EpicPicker({ icon, title, description, onSelect }: EpicPickerProps) {
  const query = useEpicList();

  if (query.isPending) return <LoadingState label="Loading Epics…" rows={4} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load the Epic list"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const epics = query.data;
  const active = epics.filter(isActive);

  // Chưa theo dõi Epic nào: không có gì để chọn — đưa thẳng sang màn Epics để thêm.
  if (epics.length === 0) {
    return (
      <EmptyState
        icon={icon}
        title="No Epics tracked yet"
        description="Add an Epic on the Epics screen first, then come back to pick it here."
        action={<GoToEpics />}
      />
    );
  }

  // Có Epic nhưng không cái nào đang active (đều tạm dừng / đang dựng lịch sử /
  // lỗi): không chọn bừa một cái không vẽ được, chỉ ra chỗ xử lý.
  if (active.length === 0) {
    return (
      <EmptyState
        icon={icon}
        title="No active Epics right now"
        description={
          `${epics.length} Epic${epics.length === 1 ? ' is' : 's are'} tracked, but none is active ` +
          'yet — they may be paused, still building history, or in error. Open the Epics screen to check.'
        }
        action={<GoToEpics />}
      />
    );
  }

  return (
    <section className="panel" aria-labelledby="epic-picker-title">
      <h2 className="panel__title" id="epic-picker-title">
        <span aria-hidden="true">{icon}</span> {title}
      </h2>
      <p className="panel__hint">{description}</p>

      <ul className="epic-picker" aria-label="Active Epics">
        {active.map((epic) => (
          <li key={epic.epicKey}>
            <button
              type="button"
              className="epic-picker__item"
              onClick={() => onSelect(epic.epicKey)}
            >
              {/* Mã ticket + tiêu đề cạnh nhau: mã để trỏ đúng ticket trên Jira,
                  tiêu đề để người dùng nhận ra "cái nào" mà không phải nhớ mã. */}
              <code className="epic-picker__key">{epic.epicKey}</code>
              <span className="epic-picker__name">{epic.displayName}</span>
              <span className="epic-picker__meta muted">
                {epic.dataHealth.subtaskCount} sub-task{epic.dataHealth.subtaskCount === 1 ? '' : 's'}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* Chỉ liệt kê Epic active — nói rõ để người tìm một Epic đã tạm dừng biết
          đường sang màn Epics thay vì tưởng nó biến mất. */}
      <p className="muted">
        Only active Epics are listed here. Paused or still-syncing Epics are on the{' '}
        <Link to="/epics">Epics screen</Link>.
      </p>
    </section>
  );
}

function GoToEpics() {
  return (
    <Link className="button button--primary" to="/epics">
      Go to Epics
    </Link>
  );
}
