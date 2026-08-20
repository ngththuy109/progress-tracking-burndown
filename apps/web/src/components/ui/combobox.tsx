import { useId, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Ô chọn CÓ TÌM KIẾM (combobox) — gõ để lọc rồi chọn, thay cho `<select>` phải
 * cuộn tay khi danh sách dài.
 *
 * Vì sao tự dựng thay vì `<select>`/`<datalist>`: `<select>` không lọc theo chuỗi
 * con (chỉ nhảy theo ký tự đầu), còn `<datalist>` mỗi trình duyệt hiển thị một
 * kiểu và không gắn được `value` tách khỏi nhãn. Ở đây cần: gõ "trần" ra "Trần
 * Bình", gõ "duc" ra "Đức" (KHÔNG bắt gõ dấu), và chọn xong giữ `accountId` ổn
 * định chứ không giữ tên.
 *
 * Bám mẫu ARIA combobox (input `role="combobox"` + `listbox`): điều hướng bằng
 * bàn phím (↑/↓/Enter/Esc) và chuột đều được, `aria-activedescendant` trỏ mục
 * đang tô để trình đọc màn hình đọc đúng.
 */

/**
 * Chuẩn hoá chuỗi để so khớp GÕ-TỚI: bỏ hoa/thường, bỏ dấu tiếng Việt, đưa đ→d.
 * Nhờ vậy gõ không dấu ("duc", "tran binh") vẫn khớp tên có dấu ("Đức", "Trần
 * Bình") — người dùng không phải bật bộ gõ chỉ để lọc.
 */
export function foldText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd');
}

export interface ComboboxOption {
  /** Giá trị ổn định báo cho nơi gọi khi chọn (vd `accountId`). */
  readonly value: string;
  /** Nhãn hiển thị + là thứ đem đi so khớp khi gõ. */
  readonly label: string;
  /** Chữ phụ hiện mờ sau nhãn (vd số ticket "12"); KHÔNG tính vào tìm kiếm. */
  readonly hint?: string;
}

/** Một tuỳ chọn có khớp với chuỗi đang gõ không (so trên nhãn, bỏ dấu). */
export function comboboxMatches(option: ComboboxOption, query: string): boolean {
  const q = foldText(query.trim());
  if (q === '') return true;
  return foldText(option.label).includes(q);
}

export interface ComboboxProps {
  readonly options: readonly ComboboxOption[];
  /** Giá trị đang chọn (khớp `option.value`). */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Tên cho trình đọc màn hình gắn vào ô nhập (vd "Filter by PIC"). */
  readonly ariaLabel: string;
  readonly placeholder?: string;
  /** Câu hiện khi gõ mà không khớp mục nào. */
  readonly emptyText?: string;
  /** Lớp CSS thêm cho khung ngoài (vd để đặt bề rộng). */
  readonly className?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder,
  emptyText = 'No match',
  className,
}: ComboboxProps) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  // `null` = KHÔNG đang gõ → ô hiện nhãn của mục đã chọn, danh sách hiện đủ. Chuỗi
  // = đang gõ → ô hiện chuỗi đó, danh sách lọc theo nó.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const selected = options.find((o) => o.value === value);
  const shown = query === null ? options : options.filter((o) => comboboxMatches(o, query));
  const activeIndex = shown.length === 0 ? -1 : Math.min(active, shown.length - 1);
  const inputValue = query ?? (selected ? selected.label : '');
  const optionId = (i: number): string => `${baseId}-opt-${i}`;

  const openList = (): void => {
    const i = options.findIndex((o) => o.value === value);
    setQuery(null);
    setActive(i < 0 ? 0 : i);
    setOpen(true);
  };

  /** Đóng và bỏ chuỗi đang gõ dở → ô quay về nhãn đã chọn (không commit chữ dở). */
  const cancel = (): void => {
    setOpen(false);
    setQuery(null);
  };

  const commit = (option: ComboboxOption): void => {
    onChange(option.value);
    setOpen(false);
    setQuery(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openList();
        else setActive(Math.min(activeIndex + 1, shown.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openList();
        else setActive(Math.max(activeIndex - 1, 0));
        break;
      case 'Enter':
        if (open && activeIndex >= 0) {
          e.preventDefault();
          const option = shown[activeIndex];
          if (option) commit(option);
        }
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          cancel();
        }
        break;
      case 'Tab':
        // Rời ô bằng Tab: đóng, KHÔNG đổi lựa chọn (giữ giá trị hiện tại).
        cancel();
        break;
      default:
        break;
    }
  };

  return (
    <span className={`combobox${className === undefined ? '' : ` ${className}`}`}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        className="input combobox__input"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={inputValue}
        onFocus={openList}
        onBlur={cancel}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="combobox__toggle"
        aria-hidden="true"
        tabIndex={-1}
        // Giữ focus ở ô nhập (không để nút cướp focus rồi làm ô blur/đóng).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) cancel();
          else openList();
          inputRef.current?.focus();
        }}
      >
        ▾
      </button>

      {open && (
        <ul id={listId} role="listbox" aria-label={ariaLabel} className="combobox__list">
          {shown.length === 0 ? (
            <li className="combobox__empty" role="presentation">
              {emptyText}
            </li>
          ) : (
            shown.map((o, i) => (
              <li
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={o.value === value}
                className={`combobox__option${i === activeIndex ? ' combobox__option--active' : ''}`}
                // Bấm mục KHÔNG được làm ô nhập blur trước khi click chạy — chặn
                // mousedown mặc định để giữ focus, rồi xử lý ở onClick.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(o)}
              >
                <span className="combobox__label">{o.label}</span>
                {o.hint !== undefined && <span className="combobox__hint">{o.hint}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </span>
  );
}
