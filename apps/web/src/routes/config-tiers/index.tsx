import { useReducer, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  deriveDefaultTiersFromPhase,
  type ConfigPayload,
  type EffectiveConfig,
  type GroupSourceType,
  type GroupTier,
  type GroupTierRule,
  type TiersPreviewRow,
} from '@app/shared';
import { useEffectiveConfig, useSaveConfig, useTiersPreview } from '../../api/use-phase-config.js';
import { Badge, ErrorState, LoadingState } from '../../components/ui/index.js';
import { indexIssues, issuesOf, NO_ISSUES } from '../config-phase/field-errors.js';
import { DeleteButton, IssueList, MoveButtons } from '../config-phase/row-controls.js';
import {
  isTierDirty,
  loadTierDraft,
  phaseTierCount,
  tierReducer,
  TIER_PRESETS,
  type TierAction,
} from './tier-draft.js';

/**
 * Màn "Cấu trúc tầng" — khai 1..N tầng nhóm logic cho dự án (DYNAMIC-TIERS-DESIGN.md).
 *
 * CHẠY TRÊN GLOBAL (single-tenant = một cấu hình). Nhờ vậy không phải lo kế thừa:
 * lưu = gửi lại nguyên payload GLOBAL, chỉ thay phần `tiers`. Bộ máy tầng nhóm tách
 * riêng khỏi màn Phase settings để reducer mỗi bên gọn.
 *
 * Vòng 3: hỗ trợ nguồn khoá dựa tiêu đề (Task cha / chính lá). LABEL / token / custom
 * field mở sau — chỉ hiện những nguồn engine đã chạy được.
 */

/** Chỉ hiện nguồn khoá engine ĐÃ hỗ trợ (resolver Vòng 3). CUSTOM_FIELD để v2. */
const SUPPORTED_SOURCES: readonly { readonly value: GroupSourceType; readonly label: string }[] = [
  { value: 'PARENT_TASK_TITLE', label: 'Tiêu đề Task cha' },
  { value: 'SELF_TITLE', label: 'Tiêu đề chính lá' },
  { value: 'SUBTASK_TITLE_TOKEN', label: 'Token trong tiêu đề Sub-task' },
  { value: 'LABEL', label: 'Nhãn Jira (label)' },
];

/** Ghi chú ngắn cạnh nguồn — đúng dòng "nguồn: … (chú thích)" của demo. */
const SOURCE_NOTE: Record<string, string> = {
  PARENT_TASK_TITLE: 'bóc từ tiêu đề Task cha',
  SELF_TITLE: 'bóc từ tiêu đề của CHÍNH lá',
  SUBTASK_TITLE_TOKEN: 'lấy một token trong mẫu tiêu đề Sub-task',
  LABEL: 'lấy từ nhãn Jira theo tiền tố',
};

/** Token bóc được từ mẫu tiêu đề Sub-task chuẩn. */
const TOKEN_OPTIONS = ['project', 'team', 'phase', 'function', 'task'] as const;

/** Bóc phần ConfigPayload ra khỏi EffectiveConfig (bỏ meta scope/version/inherited). */
function payloadFromConfig(c: EffectiveConfig): ConfigPayload {
  return {
    fallbackScanFullTitle: c.fallbackScanFullTitle,
    titlePatterns: c.titlePatterns,
    subtaskPatterns: c.subtaskPatterns,
    phaseDefinitions: c.phaseDefinitions,
    matchRules: c.matchRules,
    signboardColumns: c.signboardColumns,
    subPhaseOrders: c.subPhaseOrders,
  };
}

export function TierStructureScreen() {
  const query = useEffectiveConfig(null); // GLOBAL — single-tenant

  if (query.isPending) return <LoadingState label="Đang tải cấu trúc tầng…" rows={3} />;
  if (query.isError) {
    return (
      <ErrorState error={query.error} title="Không tải được cấu trúc tầng" onRetry={() => void query.refetch()} />
    );
  }

  return (
    <div className="stack">
      <TierEditor key="GLOBAL" config={query.data} />
    </div>
  );
}

function TierEditor({ config }: { readonly config: EffectiveConfig }) {
  const initialTiers =
    config.tiers && config.tiers.length > 0 ? config.tiers : deriveDefaultTiersFromPhase(config);
  const [state, dispatch] = useReducer(tierReducer, initialTiers, loadTierDraft);
  const [note, setNote] = useState('');
  const save = useSaveConfig();
  const errors = save.isError ? indexIssues(issuesOf(save.error)) : NO_ISSUES;

  const phaseCount = phaseTierCount(state);
  const phaseOk = phaseCount === 1;
  const [guideOpen, setGuideOpen] = useState(false);

  return (
    <>
      <ConfigTypeHeader dispatch={dispatch} />

      {/* Thanh hướng dẫn — đúng demo: mở modal 7 bước ngay trong app. */}
      <div className="glbar">
        <span aria-hidden="true">📖</span>
        <span>
          <strong>Chưa biết bắt đầu từ đâu?</strong> Xem hướng dẫn từng bước thiết lập cấu hình
          phân tầng cho một dự án.
        </span>
        <button type="button" className="glbar__open" onClick={() => setGuideOpen(true)}>
          Mở hướng dẫn cấu hình →
        </button>
      </div>
      {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}

      {!phaseOk && (
        <p className="notice notice--error" role="alert">
          {phaseCount === 0
            ? 'Chưa có tầng nào là Phase. Đánh dấu đúng một tầng là Phase.'
            : `Có ${phaseCount} tầng đang là Phase. Chỉ được đúng một.`}
        </p>
      )}

      {/* Bố cục hai cột của demo: trái = Bước 1 + Bước 2; phải = Xem thử (sticky). */}
      <div className="tiers-grid">
        <div className="stack">
          <ScopeInfoCard />

          <section className="panel" aria-labelledby="tiers-list-title">
            <p className="panel__eyebrow">Bước 2 · Các tầng nhóm</p>
            <h2 className="panel__title" id="tiers-list-title">
              Cấu trúc phân tầng <span className="muted">· {state.tiers.length} tầng</span>
            </h2>
            <p className="panel__hint">
              Mỗi tầng chọn <strong>nguồn khoá</strong> và đánh dấu <strong>đúng một</strong> tầng
              là <em>Phase</em> — tầng gắn với Signboard và đường Kế hoạch. Bấm <strong>Sửa ✎</strong>{' '}
              để mở trình sửa giá trị/luật/mẫu của tầng.
            </p>

            <ol className="stack tier-list">
              {state.tiers.map((tier, i) => (
                <TierRow
                  key={i}
                  tier={tier}
                  index={i}
                  total={state.tiers.length}
                  errors={errors}
                  dispatch={dispatch}
                />
              ))}
            </ol>

            <button type="button" className="button" onClick={() => dispatch({ type: 'ADD_TIER' })}>
              + Thêm tầng
            </button>

            <IssueList issues={errors.at('tiers')} />
          </section>
        </div>

        <TiersPreviewCard tiers={state.tiers} />
      </div>

      <section className="panel">
        <label className="field">
          <span>Ghi chú cho thay đổi này</span>
          <input
            className="input input--wide"
            value={note}
            placeholder="Ví dụ: tách thêm tầng Stream"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </section>

      {save.isSuccess && (
        <p className="notice notice--ok" role="status">
          Đã lưu bản v{save.data.version}. {save.data.affectedEpics} Epic sẽ được tính lại.
        </p>
      )}
      {save.isError && !errors.hasBlocking && (
        <ErrorState error={save.error} title="Không lưu được cấu trúc tầng" />
      )}
      {errors.hasBlocking && (
        <p className="notice notice--error" role="alert">
          Cấu hình chưa hợp lệ nên <strong>chưa lưu gì cả</strong>. Xem các dòng báo đỏ.
        </p>
      )}

      <div className="actions actions--sticky">
        <span className="muted">{isTierDirty(state) ? 'Có thay đổi chưa lưu' : 'Chưa thay đổi'}</span>
        <button
          type="button"
          className="button button--primary"
          disabled={!isTierDirty(state) || save.isPending || !phaseOk}
          onClick={() =>
            save.mutate(
              {
                projectKey: null,
                payload: { ...payloadFromConfig(config), tiers: [...state.tiers] },
                note: note === '' ? null : note,
              },
              { onSuccess: () => dispatch({ type: 'COMMIT' }) },
            )
          }
        >
          {save.isPending ? 'Đang lưu…' : '💾 Lưu cấu trúc tầng'}
        </button>
      </div>
    </>
  );
}

/**
 * Xem thử — cột phải sticky của demo: dán các tiêu đề Task (mỗi dòng một ticket
 * mẫu) → bảng `tiêu đề → group_path` với chip theo tầng, phần tử tầng Phase có viền.
 *
 * Kiểm ngay tại chỗ, không phải Lưu rồi Resync mới biết luật có ăn không. Chỉ chạy
 * được tầng bóc từ tiêu đề Task cha; tầng nguồn khác hiện "…" (cần dữ liệu lá).
 */
function TiersPreviewCard({ tiers }: { readonly tiers: readonly GroupTier[] }) {
  const [text, setText] = useState('');
  const preview = useTiersPreview();

  const titles = text
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => t !== '');

  const run = (): void => {
    if (titles.length === 0) return;
    preview.mutate({ taskTitles: titles.slice(0, 50), tiers });
  };

  /** Màu chip: tra định nghĩa của ĐÚNG tầng đó trong bản nháp (theo mã đã bóc). */
  const colorOf = (tierIndexInPath: number, code: string): string | null => {
    const sorted = [...tiers].sort((a, b) => a.tierOrder - b.tierOrder);
    return sorted[tierIndexInPath]?.definitions.find((d) => d.groupCode === code)?.colorHex ?? null;
  };

  return (
    <section className="panel tiers-preview" aria-labelledby="tiers-preview-title">
      <p className="panel__eyebrow panel__eyebrow--plain">Xem thử · không cần chờ sync</p>
      <h2 className="panel__title" id="tiers-preview-title">
        Ticket mẫu → <code>group_path</code>
      </h2>
      <p className="panel__hint">
        Mỗi lá thành một <strong>vectơ khoá</strong> theo tầng. Ô có viền = phần tử tầng{' '}
        <em>Phase</em>. Dán tiêu đề Task thật, mỗi dòng một ticket.
      </p>

      <textarea
        className="input"
        rows={4}
        value={text}
        placeholder={'[PAY][offshore_P1]Design\n[PAY][offshore_P2]Development'}
        aria-label="Tiêu đề Task để xem thử, mỗi dòng một ticket"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={titles.length === 0 || preview.isPending}
          onClick={run}
        >
          {preview.isPending ? 'Đang bóc…' : 'Xem thử'}
        </button>
        {titles.length > 50 && <span className="muted">Chỉ bóc 50 dòng đầu.</span>}
      </div>

      {preview.isError && <ErrorState error={preview.error} title="Không xem thử được" />}

      {preview.data && (
        <div className="tbl-scroll" aria-live="polite">
          <table className="tiers-preview__table">
            <thead>
              <tr>
                <th>Tiêu đề</th>
                <th>group_path</th>
              </tr>
            </thead>
            <tbody>
              {preview.data.results.map((row) => (
                <tr key={row.taskTitle}>
                  <td className="tiers-preview__title">{row.taskTitle}</td>
                  <td>
                    <PathChips row={row} colorOf={colorOf} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="panel__hint">
            Ô "…" = tầng lấy nguồn từ dữ liệu LÁ (title lá / token / label) — không bóc được từ
            tiêu đề Task. <code>UNCLASSIFIED</code> = không luật nào khớp, kiểm lại từ khoá.
          </p>
        </div>
      )}
    </section>
  );
}

/** Vectơ khoá của một dòng preview — chip theo tầng, phần tử tầng Phase có viền. */
function PathChips({
  row,
  colorOf,
}: {
  readonly row: TiersPreviewRow;
  readonly colorOf: (tierIndexInPath: number, code: string) => string | null;
}) {
  return (
    <span className="gp-path">
      {row.entries.map((e, i) => {
        const color = e.resolved === null ? null : colorOf(i, e.resolved);
        return (
          <span key={e.code} className="gp-path__pair">
            {i > 0 && <span className="gp-sep">›</span>}
            <span
              className={`gp-node${e.role === 'PHASE' ? ' gp-node--phase' : ''}${
                e.resolved === 'UNCLASSIFIED' ? ' gp-node--warn' : ''
              }`}
              style={color === null ? undefined : { borderColor: color, color }}
              title={
                e.resolved === null
                  ? `Tầng ${e.labelVi || e.code}: nguồn "${e.sourceType}" cần dữ liệu lá`
                  : `Tầng ${e.labelVi || e.code}`
              }
            >
              {e.resolved ?? '…'}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * Bước 1 của demo — card MÔ TẢ phạm vi theo dõi (CONTAINER/QUERY). Scope thật được
 * đăng ký THEO TỪNG Epic ở màn Epics; card này giữ đúng vị trí "Bước 1" trong luồng
 * thiết lập để người mới không bỏ sót bước đăng ký scope.
 */
function ScopeInfoCard() {
  return (
    <section className="panel" aria-labelledby="scope-info-title">
      <p className="panel__eyebrow">Bước 1 · Phạm vi theo dõi</p>
      <h2 className="panel__title" id="scope-info-title">
        Tracked scope
      </h2>
      <p className="panel__hint">
        Hệ thống tính số trên <strong>tập lá</strong> của mỗi scope. Hai cách khoanh tập lá:
      </p>
      <dl className="scope-kv">
        <dt>
          <Badge tone="info">CONTAINER</Badge>
        </dt>
        <dd>
          Đăng ký một Epic/Task container — lá là <strong>Sub-task/hậu duệ</strong> của nó (mô hình
          3 tầng gốc).
        </dd>
        <dt>
          <Badge tone="neutral">QUERY</Badge>
        </dt>
        <dd>
          Dự án phẳng không có ticket cha — khai một <strong>JQL</strong>, lá là ticket khớp truy
          vấn.
        </dd>
      </dl>
      <p className="panel__hint">
        Đăng ký / sửa scope cho từng dự án ở màn <Link to="/epics">Epics</Link>. Cấu trúc tầng ở
        trang này áp <strong>chung</strong> cho mọi scope.
      </p>
    </section>
  );
}

/** Header "Chọn kiểu cấu trúc phân tầng" — đúng khối đầu trang của demo. */
function ConfigTypeHeader({ dispatch }: { readonly dispatch: (a: TierAction) => void }) {
  return (
    <section className="panel cfg-head" aria-labelledby="preset-title">
      <div>
        <p className="panel__eyebrow">Cấu hình global · single-tenant</p>
        <h2 className="panel__title" id="preset-title">
          Chọn kiểu cấu trúc phân tầng
        </h2>
        <p className="panel__hint">
          Áp cho <strong>toàn hệ thống</strong> — mọi tracked scope dùng chung cấu trúc này. Chọn
          một mẫu để bắt đầu nhanh, rồi tinh chỉnh bên dưới.
        </p>
      </div>
      <div className="scope" role="group" aria-label="Chọn kiểu cấu hình">
        {TIER_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="button"
            title={p.hint}
            onClick={() => dispatch({ type: 'REPLACE_TIERS', tiers: p.build() })}
          >
            {p.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Modal "Hướng dẫn cấu hình" — nội dung 7 bước của demo, ngay trong app. */
function GuideModal({ onClose }: { readonly onClose: () => void }) {
  return (
    <div
      className="guide-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <div className="guide-modal__head">
          <div>
            <p className="panel__eyebrow">Hướng dẫn</p>
            <h2 className="panel__title" id="guide-title">
              Thiết lập cấu hình phân tầng cho một dự án
            </h2>
          </div>
          <button type="button" className="button" aria-label="Đóng hướng dẫn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="guide-modal__body">
          <p className="panel__hint">
            Cấu hình trả lời 3 câu: <strong>theo dõi cái gì</strong>,{' '}
            <strong>gom nhóm theo mấy tầng</strong>, và <strong>mỗi tầng lấy khoá từ đâu</strong>.
            Làm lần lượt:
          </p>

          <div className="guide-myth">
            <p className="guide-myth__head">⚠️ Đừng nhầm hai chữ "tầng"</p>
            <p>
              🏢 <strong>Nhà Jira — 3 tầng CỐ ĐỊNH</strong> (Epic → Task = [Phase] → Sub-task):
              chiều sâu cây issue, Jira định sẵn — "3 tầng" trong tên preset chính là cái này.
              {' '}📏 <strong>Tầng nhóm — BẠN xếp (1..N)</strong>: số "lát cắt" để cộng dồn số
              liệu; preset "3 tầng" chỉ đặt <strong>1</strong> lát = Phase. Muốn gom sâu hơn
              (Giai đoạn, Stream…) bấm <strong>+ Thêm tầng</strong> — không giới hạn số lượng.
            </p>
          </div>

          <ol className="guide-steps">
            <li>
              <strong>Chọn phạm vi theo dõi (tracked scope).</strong> Có ticket cha →{' '}
              <code>CONTAINER</code> (dán key Epic/Task ở màn Epics). Dự án phẳng →{' '}
              <code>QUERY</code> (viết JQL). Lá = tầng mang số liệu (estimate/worklog).
            </li>
            <li>
              <strong>Khai các tầng nhóm (1..N), từ trên xuống.</strong> Mỗi tầng đặt tên + chọn
              nguồn khoá: title Task cha · title của lá · token tiêu đề · label. Ít nhất 1 tầng.
            </li>
            <li>
              <strong>Đánh dấu đúng MỘT tầng là Phase.</strong> Tầng Phase giữ các tính năng theo
              Phase: Signboard, đường Kế hoạch, cảnh báo dịch chuyển. Tầng khác chỉ nhóm & cộng dồn.
            </li>
            <li>
              <strong>Với tầng lấy từ tiêu đề: thêm mẫu & luật.</strong> Mẫu tiêu đề (VD{' '}
              <code>{'[{project}][{name}]{task}'}</code>) + luật từ khoá → mã (VD{' '}
              <code>offshore_P1 → GD1</code>). Dùng <strong>Xem thử</strong> bên phải để kiểm ngay.
            </li>
            <li>
              <strong>Cấu hình Signboard columns (cho tầng Phase).</strong> Loại task
              (Create/Review/Fix…), phía làm VN/JP, mẫu tiêu đề Sub-task, thứ tự Sub-phase.
            </li>
            <li>
              <strong>Gắn lịch làm việc.</strong> Chọn lịch VN/JP cho scope ở màn Days off — quyết
              định cách tính đường Kế hoạch.
            </li>
            <li>
              <strong>Xem thử → Lưu.</strong> Đối chiếu <code>group_path</code> ở khung Xem thử.
              Lưu xong hệ thống tự backfill (tối đa ~1 giờ); muốn thấy ngay thì Resync mức Toàn bộ.
            </li>
          </ol>

          <p className="guide-tip">
            <strong>Nguyên tắc vàng:</strong> chỉ <strong>tầng lá</strong> mang số liệu thật
            (estimate/worklog/ngày). Tầng nhóm — kể cả Phase — không tự có số; số của chúng là{' '}
            <strong>tổng cộng dồn</strong> từ lá lên.
          </p>

          <p className="panel__hint">
            Chi tiết kỹ thuật & công thức ca "Giai đoạn": <code>docs/DYNAMIC-TIERS-DESIGN.md</code>{' '}
            §9. Bản demo tương tác: <code>docs/dynamic-tiers-demo.html</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * MỘT tầng — hàng GỌN theo demo: điều khiển + dòng tóm tắt nguồn/giá trị; phần
 * giá trị/luật/mẫu XẾP LẠI sau nút "Sửa ✎" thay vì trải hết ra màn.
 *
 * Riêng tầng ✦Phase nguồn "Tiêu đề Task cha": engine đọc cấu hình Phase (phase_*)
 * chứ KHÔNG đọc luật khai ở đây, nên "Sửa ✎" dẫn thẳng sang màn Phase settings —
 * trưng trình sửa tại chỗ cho nó là mời người dùng sửa vào chỗ không có tác dụng.
 */
function TierRow({
  tier,
  index,
  total,
  errors,
  dispatch,
}: {
  readonly tier: GroupTier;
  readonly index: number;
  readonly total: number;
  readonly errors: ReturnType<typeof indexIssues>;
  readonly dispatch: (a: TierAction) => void;
}) {
  const name = tier.code === '' ? `tầng ${index + 1}` : tier.code;
  const [open, setOpen] = useState(false);
  const editsInPhaseSettings = tier.role === 'PHASE' && tier.sourceType === 'PARENT_TASK_TITLE';
  const sourceLabel =
    SUPPORTED_SOURCES.find((s) => s.value === tier.sourceType)?.label ?? tier.sourceType;

  return (
    <li className="tier-row" aria-label={`Tầng ${index + 1}`}>
      <div className="row tier-row__head">
        <MoveButtons
          label={name}
          index={index}
          total={total}
          onMove={(delta) => dispatch({ type: 'MOVE_TIER', index, delta })}
        />
        <span className="tier-row__ord" aria-hidden="true">
          {tier.tierOrder}
        </span>
        <input
          className="input"
          value={tier.labelVi}
          placeholder="Tên hiển thị"
          aria-label={`Tên tầng ${index + 1}`}
          onChange={(e) => dispatch({ type: 'UPDATE_TIER', index, patch: { labelVi: e.target.value } })}
        />
        {tier.role === 'PHASE' ? <Badge tone="success">PHASE</Badge> : <Badge tone="neutral">GROUP</Badge>}
        <input
          className="input input--code"
          value={tier.code}
          placeholder="Mã tầng"
          aria-label={`Mã tầng ${index + 1}`}
          onChange={(e) => dispatch({ type: 'UPDATE_TIER', index, patch: { code: e.target.value } })}
        />
        <label className="field field--inline">
          <input
            type="radio"
            name="phase-tier"
            checked={tier.role === 'PHASE'}
            aria-label={`Đặt tầng ${index + 1} là Phase`}
            onChange={() => dispatch({ type: 'SET_PHASE_TIER', index })}
          />
          <span>Là tầng Phase</span>
        </label>
        {editsInPhaseSettings ? (
          <Link className="button" to="/config/phase" title="Giá trị & luật của tầng Phase sửa ở Phase settings">
            Sửa ✎
          </Link>
        ) : (
          <button
            type="button"
            className="button"
            aria-expanded={open}
            aria-label={`Sửa giá trị/luật/mẫu của tầng ${index + 1}`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Thu gọn ▴' : 'Sửa ✎'}
          </button>
        )}
        <DeleteButton label={name} onClick={() => dispatch({ type: 'REMOVE_TIER', index })} />
      </div>

      {/* Dòng tóm tắt như demo: "nguồn: X (chú thích)" + chips giá trị chuẩn. */}
      <div className="tier-row__src">
        <span className="muted">nguồn:</span>
        <select
          className="input input--sm"
          value={tier.sourceType}
          aria-label={`Nguồn khoá tầng ${index + 1}`}
          onChange={(e) =>
            dispatch({ type: 'UPDATE_TIER', index, patch: { sourceType: e.target.value as GroupSourceType } })
          }
        >
          {/* Nếu tầng đang mang nguồn CHƯA hỗ trợ (từ config cũ) vẫn hiện để không mất. */}
          {!SUPPORTED_SOURCES.some((s) => s.value === tier.sourceType) && (
            <option value={tier.sourceType}>{tier.sourceType} (chưa hỗ trợ)</option>
          )}
          {SUPPORTED_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="muted">{SOURCE_NOTE[tier.sourceType] ?? sourceLabel}</span>
        {editsInPhaseSettings ? (
          <span className="muted">
            · giá trị & luật nằm ở <Link to="/config/phase">Phase settings</Link>
          </span>
        ) : (
          tier.definitions.length > 0 && (
            <span className="tier-row__defs">
              {tier.definitions.map((d, j) => (
                <span
                  key={j}
                  className="defchip"
                  style={d.colorHex == null ? undefined : { borderColor: d.colorHex, color: d.colorHex }}
                >
                  {d.groupCode || '—'}
                </span>
              ))}
            </span>
          )
        )}
      </div>

      <TierSourceParam tier={tier} index={index} dispatch={dispatch} />

      <IssueList issues={errors.atRow('tiers', index)} />

      {open && !editsInPhaseSettings && (
        <div className="tier-row__editor">
          <TierDefinitions tier={tier} index={index} dispatch={dispatch} />
          <TierRules tier={tier} index={index} dispatch={dispatch} />
          <TierPatterns tier={tier} index={index} dispatch={dispatch} />
        </div>
      )}
    </li>
  );
}

/** Tham số phụ của nguồn khoá: tên token (SUBTASK_TITLE_TOKEN) hoặc tiền tố (LABEL). */
function TierSourceParam({
  tier,
  index,
  dispatch,
}: {
  readonly tier: GroupTier;
  readonly index: number;
  readonly dispatch: (a: TierAction) => void;
}) {
  if (tier.sourceType === 'SUBTASK_TITLE_TOKEN') {
    const token = String(tier.sourceConfig?.['token'] ?? '');
    return (
      <label className="field field--inline">
        <span>Token</span>
        <select
          className="input"
          value={token}
          aria-label={`Token nguồn tầng ${index + 1}`}
          onChange={(e) => dispatch({ type: 'SET_SOURCE_CONFIG', index, key: 'token', value: e.target.value })}
        >
          <option value="">(chọn token)</option>
          {TOKEN_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (tier.sourceType === 'LABEL') {
    const prefix = String(tier.sourceConfig?.['prefix'] ?? '');
    return (
      <label className="field field--inline">
        <span>Tiền tố nhãn</span>
        <input
          className="input input--code"
          value={prefix}
          placeholder="team:"
          aria-label={`Tiền tố nhãn tầng ${index + 1}`}
          onChange={(e) => dispatch({ type: 'SET_SOURCE_CONFIG', index, key: 'prefix', value: e.target.value })}
        />
      </label>
    );
  }
  return null;
}

function TierDefinitions({
  tier,
  index,
  dispatch,
}: {
  readonly tier: GroupTier;
  readonly index: number;
  readonly dispatch: (a: TierAction) => void;
}) {
  return (
    <fieldset className="subsection">
      <legend>Giá trị chuẩn của tầng</legend>
      <ul className="rows">
        {tier.definitions.map((d, j) => (
          <li className="row" key={j}>
            <input
              className="input input--code"
              value={d.groupCode}
              placeholder="Mã"
              aria-label={`Mã giá trị ${j + 1} của tầng ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_DEF', tier: index, index: j, patch: { groupCode: e.target.value } })}
            />
            <input
              className="input"
              value={d.labelVi}
              placeholder="Tên"
              aria-label={`Tên giá trị ${j + 1} của tầng ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_DEF', tier: index, index: j, patch: { labelVi: e.target.value } })}
            />
            <input
              className="input input--color"
              type="color"
              value={d.colorHex ?? '#888888'}
              aria-label={`Màu giá trị ${j + 1} của tầng ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_DEF', tier: index, index: j, patch: { colorHex: e.target.value } })}
            />
            <DeleteButton label={d.groupCode || `giá trị ${j + 1}`} onClick={() => dispatch({ type: 'REMOVE_DEF', tier: index, index: j })} />
          </li>
        ))}
      </ul>
      <button type="button" className="button button--small" onClick={() => dispatch({ type: 'ADD_DEF', tier: index })}>
        + Thêm giá trị
      </button>
    </fieldset>
  );
}

function TierRules({
  tier,
  index,
  dispatch,
}: {
  readonly tier: GroupTier;
  readonly index: number;
  readonly dispatch: (a: TierAction) => void;
}) {
  return (
    <fieldset className="subsection">
      <legend>Luật khớp từ khoá → mã</legend>
      <ul className="rows">
        {tier.rules.map((r, j) => (
          <li className="row" key={j}>
            <input
              className="input"
              value={r.keyword}
              placeholder="Từ khoá"
              aria-label={`Từ khoá luật ${j + 1} của tầng ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_RULE', tier: index, index: j, patch: { keyword: e.target.value } })}
            />
            <select
              className="input"
              value={r.matchMode}
              aria-label={`Chế độ khớp luật ${j + 1} của tầng ${index + 1}`}
              onChange={(e) =>
                dispatch({
                  type: 'UPDATE_RULE',
                  tier: index,
                  index: j,
                  patch: { matchMode: e.target.value as GroupTierRule['matchMode'] },
                })
              }
            >
              <option value="CONTAINS">Chứa</option>
              <option value="REGEX">Regex</option>
            </select>
            <span className="muted">→</span>
            <input
              className="input input--code"
              value={r.groupCode}
              placeholder="Mã"
              aria-label={`Mã đích luật ${j + 1} của tầng ${index + 1}`}
              onChange={(e) => dispatch({ type: 'UPDATE_RULE', tier: index, index: j, patch: { groupCode: e.target.value } })}
            />
            <input
              className="input input--number"
              type="number"
              value={r.matchPriority}
              aria-label={`Ưu tiên luật ${j + 1} của tầng ${index + 1}`}
              onChange={(e) =>
                dispatch({ type: 'UPDATE_RULE', tier: index, index: j, patch: { matchPriority: Number(e.target.value) } })
              }
            />
            <DeleteButton label={r.keyword || `luật ${j + 1}`} onClick={() => dispatch({ type: 'REMOVE_RULE', tier: index, index: j })} />
          </li>
        ))}
      </ul>
      <button type="button" className="button button--small" onClick={() => dispatch({ type: 'ADD_RULE', tier: index })}>
        + Thêm luật
      </button>
    </fieldset>
  );
}

function TierPatterns({
  tier,
  index,
  dispatch,
}: {
  readonly tier: GroupTier;
  readonly index: number;
  readonly dispatch: (a: TierAction) => void;
}) {
  return (
    <fieldset className="subsection">
      <legend>Mẫu tiêu đề (tuỳ chọn)</legend>
      <ul className="rows">
        {tier.titlePatterns.map((p, j) => (
          <li className="row" key={j}>
            <input
              className="input input--wide"
              value={p.patternText}
              placeholder="[{name}] {rest}"
              aria-label={`Mẫu tiêu đề ${j + 1} của tầng ${index + 1}`}
              onChange={(e) =>
                dispatch({ type: 'UPDATE_PATTERN', tier: index, index: j, patch: { patternText: e.target.value } })
              }
            />
            <DeleteButton label={`mẫu ${j + 1}`} onClick={() => dispatch({ type: 'REMOVE_PATTERN', tier: index, index: j })} />
          </li>
        ))}
      </ul>
      <button type="button" className="button button--small" onClick={() => dispatch({ type: 'ADD_PATTERN', tier: index })}>
        + Thêm mẫu
      </button>
    </fieldset>
  );
}
