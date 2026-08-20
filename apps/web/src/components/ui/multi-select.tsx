/**
 * Ô lọc CHỌN NHIỀU — nút mở popover chứa danh sách checkbox.
 *
 * Vì sao có component riêng thay vì `<select>` gốc: bảng lỗi trộn nhiều Epic /
 * nhiều người / nhiều loại lỗi cần lọc theo TỔ HỢP ("An HOẶC Bình", "thiếu ước
 * lượng HOẶC sai định dạng"), mà `<select>` một-lựa-chọn không diễn tả được, còn
 * `<select multiple>` gốc thì phải giữ Ctrl để bấm — người dùng không đoán ra.
 *
 * Dùng `<details>` cho popover NATIVE: mở/đóng bằng cả bàn phím lẫn chuột và
 * không phải bắt "bấm ra ngoài" bằng JS (theo mẫu ở logwork/capacity-settings).
 *
 * "Không chọn gì" = "tất cả": mảng rỗng nghĩa là không thu hẹp, giống ô "All …"
 * cũ. Nút Clear đưa về đúng trạng thái đó.
 */

export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
  /** Số ticket của mục này (hiện trong ngoặc) — thấy khối lượng TRƯỚC khi lọc. */
  readonly count?: number;
}

export interface MultiSelectProps {
  /** Nhãn ngắn đứng trước, ví dụ "Epic", "PIC", "Problem". */
  readonly label: string;
  /** Chữ hiện khi chưa chọn gì, ví dụ "All epics". */
  readonly allLabel: string;
  readonly options: readonly MultiSelectOption[];
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  /** Cho trình đọc màn hình — nút tóm tắt tự nó không đủ rõ ngữ cảnh. */
  readonly ariaLabel?: string;
}

/**
 * Chữ tóm tắt trên nút: "All …" khi chưa chọn, tên mục khi chọn đúng một, còn
 * lại là "N selected" — số nói đủ mà không kéo dài nút thành cả danh sách.
 */
function summarise(
  selected: readonly string[],
  options: readonly MultiSelectOption[],
  allLabel: string,
): string {
  if (selected.length === 0) return allLabel;
  if (selected.length === 1) {
    const only = options.find((o) => o.value === selected[0]);
    return only?.label ?? allLabel;
  }
  return `${selected.length} selected`;
}

export function MultiSelect({
  label,
  allLabel,
  options,
  selected,
  onChange,
  ariaLabel,
}: MultiSelectProps) {
  const toggle = (value: string): void => {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
    );
  };

  return (
    <span className="multi-select">
      <details className="multi-select__details">
        <summary className="button multi-select__summary" aria-label={ariaLabel}>
          <span className="muted">{label}</span> {summarise(selected, options, allLabel)}
          <span aria-hidden="true"> ▾</span>
        </summary>
        <div className="panel multi-select__panel" role="group" aria-label={ariaLabel ?? label}>
          <div className="multi-select__head">
            <span className="muted">{label}</span>
            {/* Clear = bỏ mọi lựa chọn = quay về "tất cả". Khoá khi đã rỗng để
                không gợi ý một thao tác không làm gì. */}
            <button
              type="button"
              className="button button--icon"
              onClick={() => onChange([])}
              disabled={selected.length === 0}
            >
              Clear
            </button>
          </div>
          {options.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing to filter here.
            </p>
          ) : (
            <div className="checks checks--stack">
              {options.map((o) => (
                <label className="check" key={o.value}>
                  <input
                    type="checkbox"
                    checked={selected.includes(o.value)}
                    onChange={() => toggle(o.value)}
                  />
                  {/* Số ticket NẰM TRONG cùng một span với tên (không tách riêng)
                      để chuỗi hiển thị là "Tên (n)": nhờ đó nhãn ô chọn khác hẳn
                      badge "Tên" trơn ở bảng, tra cứu theo chữ không lẫn hai nơi. */}
                  <span>
                    {o.label}
                    {o.count !== undefined && <span className="muted"> ({o.count})</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      </details>
    </span>
  );
}
