import { describe, expect, it } from 'vitest';
import type { OpsMetric } from '@app/shared';
import { dataProblemsTitle, epicDataProblems } from './data-quality-hint.js';

const metric = (over: Partial<OpsMetric> = {}): OpsMetric => ({
  name: 'missingWbsDate',
  label: 'Sub-task thiếu ngày kế hoạch',
  value: 12,
  threshold: 10,
  unit: '%',
  level: 'WARN',
  ...over,
});

describe('epicDataProblems', () => {
  it('Epic sạch thì KHÔNG có lý do nào — màn hình Epics không hiện hướng dẫn', () => {
    const reasons = epicDataProblems({
      metrics: [metric({ value: 0, level: 'OK' })],
      planConflictCount: 0,
    });

    expect(reasons).toEqual([]);
  });

  it('số đo dương thành một lý do đọc được, kèm giá trị', () => {
    const reasons = epicDataProblems({ metrics: [metric()], planConflictCount: 0 });

    expect(reasons).toEqual(['Sub-task thiếu ngày kế hoạch: 12%']);
  });

  it('"chưa đo được" KHÔNG phải lỗi dữ liệu nên không thành cảnh báo', () => {
    // Epic chưa có Sub-task nào: số đo là `null`. Biến nó thành cảnh báo là bắt
    // PM đi sửa một thứ không tồn tại.
    const reasons = epicDataProblems({
      metrics: [metric({ value: null, level: 'UNKNOWN' })],
      planConflictCount: 0,
    });

    expect(reasons).toEqual([]);
  });

  it('plan rơi vào ngày nghỉ cũng là dữ liệu cần sửa, kể cả khi mọi số đo đều sạch', () => {
    const reasons = epicDataProblems({
      metrics: [metric({ value: 0, level: 'OK' })],
      planConflictCount: 2,
    });

    expect(reasons).toEqual(['2 planned start/end dates on a day off']);
  });

  it('một vi phạm thì viết số ít, không phải "1 dates"', () => {
    const reasons = epicDataProblems({ planConflictCount: 1 });

    expect(reasons).toEqual(['1 planned start/end date on a day off']);
  });

  it('chưa đọc được số đo thì chỉ còn phần kiểm được, không đoán thêm', () => {
    const reasons = epicDataProblems({ planConflictCount: 0 });

    expect(reasons).toEqual([]);
  });

  it('gộp mọi lý do lại, số đo trước rồi tới ngày nghỉ', () => {
    const reasons = epicDataProblems({
      metrics: [metric(), metric({ name: 'missingEstimate', label: 'Sub-task thiếu ước lượng', value: 5 })],
      planConflictCount: 3,
    });

    expect(reasons).toEqual([
      'Sub-task thiếu ngày kế hoạch: 12%',
      'Sub-task thiếu ước lượng: 5%',
      '3 planned start/end dates on a day off',
    ]);
  });

  it('đơn vị khác phần trăm vẫn đọc xuôi', () => {
    const reasons = epicDataProblems({
      metrics: [metric({ label: 'Ngày thiếu snapshot', value: 3, unit: 'ngày' })],
      planConflictCount: 0,
    });

    expect(reasons).toEqual(['Ngày thiếu snapshot: 3 ngày']);
  });
});

describe('dataProblemsTitle', () => {
  it('nói sai cái gì TRƯỚC, rồi mới nói đi đâu để sửa', () => {
    const title = dataProblemsTitle(['Sub-task thiếu ngày kế hoạch: 12%']);

    expect(title).toBe(
      'Sub-task thiếu ngày kế hoạch: 12%. Open Monitoring → Data quality to see the tickets and fix them in Jira.',
    );
  });
});
