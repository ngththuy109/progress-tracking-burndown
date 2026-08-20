import { DQ_PROBLEMS, type DataQualityIssue, type DqProblem, type SignboardPic } from '@app/shared';

/**
 * Lọc danh sách ticket lỗi dữ liệu theo Epic, PIC và loại lỗi — HÀM THUẦN.
 *
 * Ba chiều lọc đều CHỌN NHIỀU: một danh sách trộn nhiều Epic / nhiều người /
 * nhiều loại lỗi cần lọc theo TỔ HỢP thì mới thành việc làm được. Người trực
 * muốn xem "ticket của An HOẶC Bình", hoặc "thiếu ước lượng HOẶC sai định dạng"
 * trong "Epic PAY HOẶC SHOP" — chọn một-lựa-chọn không diễn tả được.
 *
 * Ngữ nghĩa: HOẶC bên trong một chiều, VÀ giữa các chiều. Mảng rỗng = "không thu
 * hẹp chiều đó" (giống ô "All …" cũ).
 *
 * Lọc ở CLIENT vì bảng chi tiết đã tải sẵn toàn bộ danh sách (một lần gọi) —
 * thêm tham số lọc cho API chỉ làm chậm mà không giúp gì thêm.
 */

/**
 * Ticket KHÔNG có người phụ trách.
 *
 * Đây là nhóm nguy hiểm nhất nên phải chọn được riêng: nó không thuộc về ai,
 * nên nếu chỉ lọc theo từng người thì những ticket này không bao giờ lọt vào
 * danh sách của ai cả — và không bao giờ được sửa.
 */
export const NO_PIC = 'NO_PIC';

export interface PicOption {
  /** `accountId` của Jira — ổn định hơn tên hiển thị (tên đổi được). */
  readonly value: string;
  readonly label: string;
  /** Số ticket lỗi đang thuộc về người này (trong phạm vi đang xét). */
  readonly count: number;
}

/** Tên hiển thị, lùi về `accountId` khi Jira chưa tra được tên. */
export function picLabel(pic: SignboardPic): string {
  return pic.displayName ?? pic.accountId;
}

/**
 * Danh sách PIC để đổ vào ô chọn, kèm số ticket của từng người.
 *
 * Sắp theo TÊN chứ không theo số lượng: người dùng đi tìm tên mình trong danh
 * sách, không đi tìm "người nhiều lỗi nhất". Nhóm "chưa có PIC" luôn đứng cuối
 * và chỉ xuất hiện khi thật sự có ticket như vậy.
 */
export function picOptions(issues: readonly DataQualityIssue[]): readonly PicOption[] {
  const byAccount = new Map<string, PicOption>();
  let noPicCount = 0;

  for (const issue of issues) {
    if (issue.pics.length === 0) {
      noPicCount += 1;
      continue;
    }
    // Một ticket có thể có nhiều người tham gia — nó phải nằm trong danh sách
    // của TỪNG người, không chỉ người đầu tiên.
    for (const pic of issue.pics) {
      const current = byAccount.get(pic.accountId);
      if (current === undefined) {
        byAccount.set(pic.accountId, { value: pic.accountId, label: picLabel(pic), count: 1 });
      } else {
        byAccount.set(pic.accountId, { ...current, count: current.count + 1 });
      }
    }
  }

  // Đối chiếu theo tiếng Việt: dữ liệu đến từ Jira, tên người có dấu.
  const named = [...byAccount.values()].sort((a, b) => a.label.localeCompare(b.label, 'vi'));
  return noPicCount === 0
    ? named
    : [...named, { value: NO_PIC, label: 'No PIC yet', count: noPicCount }];
}

export interface IssueFilter {
  /** Các mã Epic được chọn. Rỗng = mọi Epic. */
  readonly epicKeys: readonly string[];
  /** Các `accountId` (và/hoặc `NO_PIC`) được chọn. Rỗng = mọi PIC. */
  readonly pics: readonly string[];
  /** Các loại lỗi (`DqProblem`) được chọn. Rỗng = mọi loại lỗi. */
  readonly problems: readonly DqProblem[];
}

export function filterIssues(
  issues: readonly DataQualityIssue[],
  filter: IssueFilter,
): readonly DataQualityIssue[] {
  return issues.filter((i) => {
    // HOẶC trong từng chiều, VÀ giữa các chiều. Mảng rỗng = không thu hẹp.
    if (filter.epicKeys.length > 0 && !filter.epicKeys.includes(i.epicKey)) return false;
    // Một ticket có thể mang nhiều lỗi — "lọc theo loại lỗi" nghĩa là "CÓ chứa
    // ÍT NHẤT MỘT trong các loại đang chọn".
    if (filter.problems.length > 0 && !filter.problems.some((p) => i.problems.includes(p))) {
      return false;
    }
    if (filter.pics.length === 0) return true;
    // Giữ ticket nếu nó khớp BẤT KỲ PIC nào đang chọn — kể cả nhóm "chưa có PIC".
    return filter.pics.some((sel) =>
      sel === NO_PIC ? i.pics.length === 0 : i.pics.some((p) => p.accountId === sel),
    );
  });
}

export interface ProblemOption {
  readonly value: DqProblem;
  /** Số ticket đang mang loại lỗi này (trong phạm vi đang xét). */
  readonly count: number;
}

/**
 * Danh sách loại lỗi để đổ vào ô chọn, kèm số ticket mỗi loại.
 *
 * Hiện ĐỦ CẢ SÁU loại của `DQ_PROBLEMS` (kể cả loại đang có 0 ticket) theo đúng
 * thứ tự đó — khớp thứ tự chip số đo phía trên. Trước đây chỉ hiện loại đang có
 * ticket nên ô lọc chỉ ra 4/6 loại, khiến người trực tưởng thiếu; với ô chọn
 * NHIỀU thì hiện đủ sáu là đúng: chọn một loại đang 0 ticket chỉ đơn giản không
 * thêm dòng nào, không còn cảnh "chọn xong bảng trống" như hồi chọn-một.
 *
 * Một ticket nhiều lỗi được đếm ở TỪNG loại (nhãn hiển thị do nơi gọi tra
 * `PROBLEM_LABEL`, tránh phụ thuộc vòng vào CSV).
 */
export function problemOptions(issues: readonly DataQualityIssue[]): readonly ProblemOption[] {
  const count = new Map<DqProblem, number>();
  for (const issue of issues) {
    for (const p of issue.problems) {
      count.set(p, (count.get(p) ?? 0) + 1);
    }
  }
  return DQ_PROBLEMS.map((p) => ({ value: p, count: count.get(p) ?? 0 }));
}

/**
 * Giữ lại những lựa chọn CÒN nằm trong danh sách hiện có.
 *
 * Danh sách PIC được tính TRONG phạm vi Epic đang chọn, nên đổi Epic xong một PIC
 * đã chọn có thể không còn ticket nào. Khi đó không được để nó âm thầm lọc (bảng
 * trống trông y hệt "Epic này sạch"): lọc bằng phần giao này để PIC ngoài phạm vi
 * tạm ngưng tác dụng, nhưng nơi gọi vẫn giữ lựa chọn gốc để khi quay lại Epic cũ
 * thì nó hiện lại.
 */
export function keepAvailable(
  selected: readonly string[],
  available: readonly string[],
): readonly string[] {
  const set = new Set(available);
  return selected.filter((v) => set.has(v));
}
