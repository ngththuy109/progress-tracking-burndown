import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { customRangeError, PeriodPicker, weekOfLocal } from './period-picker.js';

/**
 * Bộ chọn kỳ — trọng tâm là tab "Custom".
 *
 * Yêu cầu: nhập KHOẢNG NGÀY TUỲ Ý (không bị ràng thứ tự bởi min/max), và phải bấm
 * "Search" mới áp dụng — chạm một ô không được tự bắn request (trước đây làm cả
 * màn hình chớp tải, bộ chọn biến mất giữa chừng).
 */

function renderPicker(onChange = vi.fn(), from: string | null = null, to: string | null = null) {
  render(
    <PeriodPicker
      from={from}
      to={to}
      rangeFrom="2026-08-10"
      rangeTo="2026-08-16"
      partialPeriod={false}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe('customRangeError', () => {
  it('đòi đủ hai đầu ngày', () => {
    expect(customRangeError('', '2026-08-16')).toMatch(/both/i);
    expect(customRangeError('2026-08-10', '')).toMatch(/both/i);
  });

  it('bắt khoảng ngược', () => {
    expect(customRangeError('2026-08-16', '2026-08-10')).toMatch(/on or after/i);
  });

  it('bắt khoảng dài quá 366 ngày', () => {
    expect(customRangeError('2025-01-01', '2026-06-01')).toMatch(/366/);
  });

  it('khoảng hợp lệ (kể cả vắt qua nhiều tháng) trả null', () => {
    expect(customRangeError('2026-01-01', '2026-08-01')).toBeNull();
    expect(customRangeError('2026-08-10', '2026-08-10')).toBeNull();
  });
});

describe('PeriodPicker — tab Custom', () => {
  it('ẩn ô ngày cho tới khi bấm "Custom"', () => {
    renderPicker();
    expect(screen.queryByLabelText('From date')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByLabelText('From date')).toBeTruthy();
    expect(screen.getByLabelText('To date')).toBeTruthy();
  });

  it('nhập khoảng tuỳ ý rồi bấm Search mới áp dụng', () => {
    const onChange = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-08-01' } });
    // Chạm ô KHÔNG được tự tìm.
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026-01-01', '2026-08-01');
  });

  it('khoảng ngược thì báo lỗi và KHÔNG tìm', () => {
    const onChange = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(screen.getByRole('alert').textContent).toMatch(/on or after/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('preset "This week" áp dụng ngay đúng tuần chứa hôm nay', () => {
    const onChange = renderPicker();
    const wk = weekOfLocal(new Date());
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(onChange).toHaveBeenCalledWith(wk.from, wk.to);
  });
});
