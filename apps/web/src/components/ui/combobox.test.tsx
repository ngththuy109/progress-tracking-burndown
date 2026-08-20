import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Combobox, comboboxMatches, foldText, type ComboboxOption } from './combobox.js';

/**
 * Ô chọn CÓ TÌM KIẾM.
 *
 * Điểm mấu chốt: gõ để lọc (kể cả KHÔNG dấu), chọn bằng chuột lẫn bàn phím, và
 * chọn xong trả đúng `value` (accountId) chứ không phải nhãn.
 */

const OPTIONS: readonly ComboboxOption[] = [
  { value: 'ALL', label: 'All PICs' },
  { value: 'a1', label: 'Nguyễn An', hint: '(2)' },
  { value: 'b2', label: 'Trần Bình', hint: '(1)' },
  { value: 'd3', label: 'Đức', hint: '(3)' },
];

function renderCombobox(onChange = vi.fn(), initial = 'ALL') {
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <Combobox
        ariaLabel="Filter by PIC"
        placeholder="All PICs"
        emptyText="No matching PIC"
        options={OPTIONS}
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
    );
  }
  render(<Harness />);
  return { onChange, input: screen.getByRole('combobox', { name: 'Filter by PIC' }) };
}

describe('foldText', () => {
  it('bỏ dấu tiếng Việt và đưa đ→d', () => {
    expect(foldText('Đức')).toBe('duc');
    expect(foldText('Trần Bình')).toBe('tran binh');
    expect(foldText('Nguyễn An')).toBe('nguyen an');
  });
});

describe('comboboxMatches', () => {
  const opt: ComboboxOption = { value: 'd3', label: 'Đức' };

  it('chuỗi rỗng khớp mọi mục', () => {
    expect(comboboxMatches(opt, '')).toBe(true);
    expect(comboboxMatches(opt, '   ')).toBe(true);
  });

  it('khớp chuỗi con, không phân biệt dấu/hoa thường', () => {
    expect(comboboxMatches(opt, 'duc')).toBe(true);
    expect(comboboxMatches(opt, 'ĐỨC')).toBe(true);
    expect(comboboxMatches({ value: 'b2', label: 'Trần Bình' }, 'binh')).toBe(true);
  });

  it('không khớp thì false', () => {
    expect(comboboxMatches(opt, 'xyz')).toBe(false);
  });
});

describe('Combobox', () => {
  it('ẩn danh sách cho tới khi mở; focus thì hiện đủ mục', () => {
    const { input } = renderCombobox();
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.focus(input);
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(4);
  });

  it('gõ để lọc — kể cả không dấu', () => {
    const { input } = renderCombobox();
    fireEvent.focus(input);

    fireEvent.change(input, { target: { value: 'trần' } });
    let options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('Trần Bình');

    // Không dấu vẫn khớp tên có dấu.
    fireEvent.change(input, { target: { value: 'duc' } });
    options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('Đức');
  });

  it('gõ không khớp ai thì hiện câu "trống"', () => {
    const { input } = renderCombobox();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'zzz' } });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching PIC')).toBeTruthy();
  });

  it('bấm một mục trả đúng value và đóng danh sách', () => {
    const { input, onChange } = renderCombobox();
    fireEvent.focus(input);

    fireEvent.click(screen.getByRole('option', { name: /Trần Bình/ }));
    expect(onChange).toHaveBeenCalledWith('b2');
    expect(screen.queryByRole('listbox')).toBeNull();
    // Ô hiện nhãn của mục đã chọn.
    expect((input as HTMLInputElement).value).toBe('Trần Bình');
  });

  it('chọn bằng bàn phím: ↓ tới mục rồi Enter', () => {
    const { input, onChange } = renderCombobox();
    fireEvent.focus(input); // mở, tô sẵn mục đang chọn (ALL, index 0)

    fireEvent.keyDown(input, { key: 'ArrowDown' }); // → index 1 (Nguyễn An)
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('a1');
  });

  it('Escape đóng danh sách, KHÔNG đổi lựa chọn', () => {
    const { input, onChange } = renderCombobox();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'trần' } });

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    // Bỏ chữ gõ dở, quay về nhãn đã chọn.
    expect((input as HTMLInputElement).value).toBe('All PICs');
  });

  it('hiển thị nhãn của value đang chọn', () => {
    const { input } = renderCombobox(vi.fn(), 'd3');
    expect((input as HTMLInputElement).value).toBe('Đức');
  });
});
