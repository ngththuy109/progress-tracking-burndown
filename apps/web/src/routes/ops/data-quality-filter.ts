import type { DataQualityIssue, SignboardPic } from '@app/shared';

/**
 * Lọc danh sách ticket lỗi dữ liệu theo Epic và theo PIC — HÀM THUẦN.
 *
 * Vì sao lọc theo PIC: người đi sửa dữ liệu trên Jira chỉ sửa được ticket của
 * CHÍNH MÌNH. Một bảng 200 dòng của cả Epic là danh sách không ai nhận; lọc
 * xuống 12 dòng mang tên một người thì đó là việc làm được ngay trong buổi sáng.
 *
 * Lọc ở CLIENT vì bảng chi tiết đã tải sẵn toàn bộ danh sách (một lần gọi) —
 * thêm tham số lọc cho API chỉ làm chậm mà không giúp gì thêm.
 */

/** Không lọc gì. */
export const ALL = 'ALL';

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
  /** Mã Epic, hoặc `ALL`. */
  readonly epicKey: string;
  /** `accountId` của PIC, `NO_PIC`, hoặc `ALL`. */
  readonly pic: string;
}

export function filterIssues(
  issues: readonly DataQualityIssue[],
  filter: IssueFilter,
): readonly DataQualityIssue[] {
  return issues.filter((i) => {
    if (filter.epicKey !== ALL && i.epicKey !== filter.epicKey) return false;
    if (filter.pic === ALL) return true;
    if (filter.pic === NO_PIC) return i.pics.length === 0;
    return i.pics.some((p) => p.accountId === filter.pic);
  });
}
