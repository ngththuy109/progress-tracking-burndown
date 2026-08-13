import type { ChangelogEvent, StatusCategory, StatusIdMap, SubtaskRecord } from '@app/shared';
import { resolveStatusCategoryAt } from '../status/resolve-status-category.js';
import { totalSpentTill } from './total-spent-till.js';
import {
  parseChangelogSeconds,
  resolveOriginalEstimateAt,
} from './resolve-original-estimate-at.js';

/**
 * Khối lượng CÒN LẠI của một Sub-task tại một mốc quá khứ — PRD §4.3.2.
 *
 * Đây là hàm cốt lõi tạo ra đường Thực tế, thứ mà biểu đồ mặc định của Jira
 * không làm được.
 *
 * Các quy tắc, xét theo ĐÚNG THỨ TỰ, dừng ngay khi khớp:
 *
 *   1.  Tại T_d đã `done`                → 0
 *   1b. CHƯA done tại T_d nhưng sẽ đóng ở tương lai, và việc làm thật đã xong
 *       (worklog cuối ≤ T_d, không sửa estimate sau đó) → 0, backdate
 *   2.  Có changelog `timeestimate` trước T_d → giá trị MỚI NHẤT
 *   3.  Còn lại                          → max(0, OriginalEstimate(T_d) − đã log tới T_d)
 *
 * VÌ SAO QUY TẮC 2 THẮNG QUY TẮC 3: khi con người đã tự khai "còn 30 giờ", ta
 * tin con người hơn phép trừ máy móc.
 *
 * VÌ SAO CÓ QUY TẮC 1b: nút Done thường bấm TRỄ hơn ngày làm thật. Nếu chờ tới
 * lúc bấm Done mới cho về 0, đường Thực tế treo phần dư suốt khoảng [làm xong →
 * bấm đóng] và biểu đồ đọc thành "task về trễ" dù việc đã xong. 1b chỉ áp khi CÓ
 * bằng chứng (worklog) và không ai sửa estimate sau worklog cuối — xem
 * `resolveDoneBackdate`.
 */

export const ESTIMATE_FIELD = 'timeestimate';
const ORIGINAL_ESTIMATE_FIELD = 'timeoriginalestimate';

/** Quy tắc nào đã được áp dụng — API `/explain` (T-25) hiển thị đúng số này. */
export type RemainingRule = 1 | '1b' | 2 | 3;

export interface HistoricalRemaining {
  readonly seconds: number;
  readonly rule: RemainingRule;
  /** Chỉ có ở quy tắc 2: giá trị con người khai và thời điểm khai. */
  readonly explicitEstimate?: { readonly seconds: number; readonly atMs: number };
  /** Chỉ có ở quy tắc 1b: mốc backdate (worklog cuối) và mốc bấm Done. */
  readonly backdate?: { readonly toMs: number; readonly doneAtMs: number };
  /** Chỉ có ở quy tắc 3. */
  readonly originalEstimateSeconds?: number;
  readonly spentSeconds?: number;
}

export function resolveHistoricalRemaining(
  sub: SubtaskRecord,
  tMs: number,
  statusIdMap: StatusIdMap,
  onWarning?: (code: string, detail: string) => void,
): HistoricalRemaining {
  // --- QUY TẮC 1 ---
  // Không được nhớ "đã done thì mãi mãi done": ca mở lại (E-13) sẽ mất trắng
  // khối lượng làm lại, và lỗi đó im lặng.
  if (resolveStatusCategoryAt(sub.changelog, statusIdMap, tMs, onWarning) === 'done') {
    return { seconds: 0, rule: 1 };
  }

  // --- QUY TẮC 1b ---
  // Đã làm xong thật (worklog cuối ≤ T_d) nhưng nút Done bấm trễ hơn: cho về 0
  // từ ngày làm thật thay vì chờ ngày bấm đóng.
  const backdate = resolveDoneBackdate(sub, tMs, statusIdMap);
  if (backdate !== null) {
    return { seconds: 0, rule: '1b', backdate };
  }

  // --- QUY TẮC 2 ---
  let latestExplicit: number | null = null;
  let latestExplicitAtMs = 0;

  for (const ev of sub.changelog) {
    if (ev.field !== ESTIMATE_FIELD) continue;
    if (ev.createdAtMs > tMs) break;
    // GÁN LẠI mỗi lần khớp, KỂ CẢ gán về `null`. Lần sửa cuối là xoá trắng thì
    // rơi xuống quy tắc 3 (E-05). Viết `if (v !== null) latestExplicit = v` là
    // sai — nó bỏ qua đúng lần xoá trắng đó.
    latestExplicit = parseChangelogSeconds(ev.toValue);
    latestExplicitAtMs = ev.createdAtMs;
  }

  if (latestExplicit !== null) {
    return {
      seconds: Math.max(0, latestExplicit),
      rule: 2,
      explicitEstimate: { seconds: latestExplicit, atMs: latestExplicitAtMs },
    };
  }

  // --- QUY TẮC 3 ---
  const original = resolveOriginalEstimateAt(sub, tMs, onWarning);
  const spent = totalSpentTill(sub, tMs);

  return {
    seconds: Math.max(0, original.seconds - spent),
    rule: 3,
    originalEstimateSeconds: original.seconds,
    spentSeconds: spent,
  };
}

/**
 * Quy tắc 1b — task sẽ đóng HẲN ở tương lai, và việc làm thật đã xong tại T_d.
 *
 * Trả về mốc backdate (worklog cuối của lượt làm) + mốc bấm Done, hoặc `null`
 * nếu KHÔNG backdate. Bốn điều kiện, thiếu một là `null`:
 *
 *   1. Có lần chuyển sang `done` ĐẦU TIÊN sau T_d (`D`). Không có → task không
 *      đóng ở tương lai, giữ nguyên hành vi cũ.
 *   2. `D` là lần đóng CUỐI CÙNG dính luôn — sau `D` không còn lần mở lại nào.
 *      Nếu sau `D` còn mở lại thì việc CHƯA thật sự xong tại T_d: lần đóng đó là
 *      đóng non (QA trả về…), phần dư của những ngày trước nó là CÓ THẬT. Chỉ lần
 *      đóng-dính-luôn mới cho phép nói "đã xong hẳn, chỉ bấm nút trễ".
 *   3. Có worklog còn hiệu lực trong LƯỢT làm `(R, D]` với `R` = lần mở lại gần
 *      nhất trước `D` (hoặc lúc tạo issue). Worklog muộn nhất là `W`, và `T_d ≥ W`
 *      — tức không còn giờ nào log sau T_d. Không có worklog → không đoán (C-10);
 *      còn worklog sau T_d → việc CHƯA xong tại T_d.
 *   4. KHÔNG có ai sửa `timeestimate`/`timeoriginalestimate` trong `(W, D]`. Sửa
 *      tay sau khi ngừng log nghĩa là phần dư CỐ Ý — tin con người như Quy tắc 2,
 *      không tự cho về 0. (Chính điều kiện này giữ nguyên bảng ví dụ PRD §4.3.2:
 *      PAY-121 sửa timeestimate=10h sau worklog cuối nên KHÔNG backdate.)
 *
 * Cửa sổ `(R, D]` bám theo TỪNG lượt làm để ca mở lại (E-13) không bị zero nhầm:
 * rework sau khi mở lại mà chưa log giờ thì giữ phần dư tới lần đóng kế tiếp.
 */
function resolveDoneBackdate(
  sub: SubtaskRecord,
  tMs: number,
  statusIdMap: StatusIdMap,
): { readonly toMs: number; readonly doneAtMs: number } | null {
  let category: StatusCategory = 'new';
  let reopenMs = sub.createdAtMs; // đáy cửa sổ: lần mở lại gần nhất, mặc định = lúc tạo
  let doneMs: number | null = null;

  for (const ev of sub.changelog) {
    if (ev.field !== 'status' || ev.toValue === null) continue;
    const next = statusIdMap.get(ev.toValue);
    if (next === undefined) continue;
    // Rời `done` = mở lại → mở một lượt làm mới.
    if (category === 'done' && next !== 'done') reopenMs = ev.createdAtMs;
    if (next === 'done' && ev.createdAtMs > tMs) {
      doneMs = ev.createdAtMs; // lần đóng ĐẦU TIÊN sau T_d
      break;
    }
    category = next;
  }
  if (doneMs === null) return null;

  // Sau doneMs còn mở lại → đóng non, không backdate (điều kiện 2).
  if (reopensAfter(sub.changelog, statusIdMap, doneMs)) return null;

  // W = worklog còn hiệu lực MUỘN NHẤT trong (reopenMs, doneMs].
  let wMs: number | null = null;
  for (const w of sub.worklogs) {
    if (w.isDeleted) continue;
    if (w.startedAtMs > reopenMs && w.startedAtMs <= doneMs && (wMs === null || w.startedAtMs > wMs)) {
      wMs = w.startedAtMs;
    }
  }
  if (wMs === null) return null; // không có bằng chứng làm thật trong lượt này
  if (tMs < wMs) return null; // còn worklog sau T_d → chưa xong tại T_d

  // Sửa estimate SAU worklog cuối = phần dư cố ý → không backdate.
  if (hasEstimateChangeBetween(sub.changelog, wMs, doneMs)) return null;

  return { toMs: wMs, doneAtMs: doneMs };
}

/** Sau mốc `doneMs`, có lần chuyển RỜI khỏi nhóm `done` (mở lại) nào không? */
function reopensAfter(
  changelog: readonly ChangelogEvent[],
  statusIdMap: StatusIdMap,
  doneMs: number,
): boolean {
  for (const ev of changelog) {
    if (ev.field !== 'status' || ev.toValue === null) continue;
    if (ev.createdAtMs <= doneMs) continue;
    const cat = statusIdMap.get(ev.toValue);
    if (cat !== undefined && cat !== 'done') return true;
  }
  return false;
}

/** Có sự kiện sửa (original) estimate nào trong khoảng mở-đóng `(fromMs, toMs]`? */
function hasEstimateChangeBetween(
  changelog: readonly ChangelogEvent[],
  fromMs: number,
  toMs: number,
): boolean {
  for (const ev of changelog) {
    if (ev.field !== ESTIMATE_FIELD && ev.field !== ORIGINAL_ESTIMATE_FIELD) continue;
    if (ev.createdAtMs > fromMs && ev.createdAtMs <= toMs) return true;
  }
  return false;
}

/**
 * Câu giải thích cho API `/explain` (T-25).
 *
 * Bằng TIẾNG ANH vì nó hiện thẳng lên bảng "Where this number comes from" trên
 * màn hình Biểu đồ, nơi khách nước ngoài và PM người Việt cùng đọc.
 */
export function explainRule(r: HistoricalRemaining): string {
  switch (r.rule) {
    case 1:
      return 'Rule 1 — the sub-task was already in the Done status category at this point, so 0 hours remain.';
    case '1b':
      return (
        'Rule 1b — the sub-task was marked Done later, but the last logged work already predates this point ' +
        'and no estimate was changed afterwards, so the effort counts as 0 from the last work day rather than ' +
        'from the (later) Done click.'
      );
    case 2:
      return (
        `Rule 2 — someone manually set the remaining estimate to ` +
        `${hours(r.explicitEstimate?.seconds ?? 0)}h. A human-entered value wins over subtraction, ` +
        `so logging more hours does not lower this number.`
      );
    case 3:
      return (
        `Rule 3 — original estimate ${hours(r.originalEstimateSeconds ?? 0)}h ` +
        `minus ${hours(r.spentSeconds ?? 0)}h already logged.`
      );
  }
}

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(2).replace(/\.00$/, '');
}
