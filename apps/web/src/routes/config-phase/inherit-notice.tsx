import type { InheritablePartKey } from '@app/shared';

/**
 * Nhãn "kế thừa từ Mặc định" + nút Ghi đè.
 *
 * Ba phần kế thừa ĐỘC LẬP NHAU (PRD §2.2.6): ghi đè mẫu tiêu đề thì danh sách
 * Phase và luật khớp vẫn kế thừa. Vì vậy mỗi khu có nhãn riêng, không phải một
 * công tắc chung cho cả trang.
 */
export interface InheritNoticeProps {
  readonly part: InheritablePartKey;
  readonly partLabel: string;
  readonly inherited: boolean;
  /** `null` = đang sửa bộ Mặc định, không có gì để kế thừa. */
  readonly projectKey: string | null;
  readonly onOverride: (part: InheritablePartKey) => void;
}

export function InheritNotice({ part, partLabel, inherited, projectKey, onOverride }: InheritNoticeProps) {
  if (projectKey === null || !inherited) return null;

  return (
    <div className="inherit" data-part={part}>
      <span className="inherit__text">
        <strong>{partLabel}</strong> is <em>inherited from the Default set</em>. Edits here do
        nothing until you click Override.
      </span>
      <button type="button" className="button" onClick={() => onOverride(part)}>
        Override for project {projectKey}
      </button>
    </div>
  );
}
