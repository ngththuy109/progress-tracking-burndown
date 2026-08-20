import { useRef, useState } from 'react';
import { foldText } from './combobox.js';

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
 *
 * `searchable` bật ô gõ-để-lọc trong popover (dùng `foldText` của combobox nên gõ
 * KHÔNG dấu vẫn khớp tên có dấu) — hợp khi danh sách dài như PIC của đội đông:
 * gõ tìm rồi vẫn tích được NHIỀU người, thứ mà combobox một-lựa-chọn không làm.
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
  /** Thêm ô gõ-để-lọc trong popover (gõ không dấu vẫn khớp). Mặc định tắt. */
  readonly searchable?: boolean;
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
  searchable = false,
}: MultiSelectProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const toggle = (value: string): void => {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
    );
  };

  // Lọc theo chữ gõ (bỏ dấu) — chỉ khi bật `searchable` và có gõ gì đó. Số đếm +
  // tóm tắt vẫn tính trên TOÀN BỘ options, không theo phần đang hiện.
  const q = foldText(query.trim());
  const shown = searchable && q !== '' ? options.filter((o) => foldText(o.label).includes(q)) : options;

  return (
    <span className="multi-select">
      <details
        className="multi-select__details"
        onToggle={(e) => {
          // Mở: đưa con trỏ thẳng vào ô tìm để gõ ngay. Đóng: xoá chữ đã gõ để lần
          // mở sau bắt đầu sạch, không lọc ngầm bằng chữ cũ.
          if (e.currentTarget.open) searchRef.current?.focus();
          else setQuery('');
        }}
      >
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
          {searchable && (
            <input
              ref={searchRef}
              type="text"
              className="input multi-select__search"
              value={query}
              placeholder={`Search ${label}…`}
              aria-label={`Search ${label}`}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {options.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing to filter here.
            </p>
          ) : shown.length === 0 ? (
            // Rỗng vì CHỮ TÌM chứ không phải hết mục — nói rõ để người dùng xoá chữ.
            <p className="muted" style={{ margin: 0 }}>
              No match
            </p>
          ) : (
            <div className="checks checks--stack">
              {shown.map((o) => (
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
