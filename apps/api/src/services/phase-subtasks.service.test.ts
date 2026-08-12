import { describe, expect, it } from 'vitest';
import {
  buildPhaseSubtaskList,
  type LoadedSubtask,
  type PhaseDefinitionLite,
} from './phase-subtasks.service.js';

function def(phaseCode: string, displayOrder: number, over: Partial<PhaseDefinitionLite> = {}): PhaseDefinitionLite {
  return { phaseCode, label: `Label ${phaseCode}`, colorHex: null, displayOrder, ...over };
}

function sub(over: Partial<LoadedSubtask> & { issueKey: string; phaseCode: string }): LoadedSubtask {
  return {
    summary: `Việc ${over.issueKey}`,
    parentKey: 'PAY-100',
    statusCategory: 'new',
    planStart: '2026-03-02',
    planEnd: '2026-03-06',
    actualStart: null,
    actualEnd: null,
    originalEstimateSeconds: 3600,
    timeSpentSeconds: 0,
    remainingEstimateSeconds: 3600,
    functionName: 'Login',
    taskType: 'Create',
    ...over,
  };
}

const EPIC = 'PAY-1';

describe('dựng danh sách Sub-task theo Phase', () => {
  it('mọi Phase đã định nghĩa đều hiện ra, KỂ CẢ nhóm chưa có ticket', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      definitions: [def('DESIGN', 1), def('DEV', 2)],
      subtasks: [sub({ issueKey: 'S-1', phaseCode: 'DESIGN' })],
    });

    expect(res.groups.map((g) => g.phaseCode)).toEqual(['DESIGN', 'DEV']);
    const dev = res.groups.find((g) => g.phaseCode === 'DEV');
    expect(dev?.tickets).toEqual([]);
    expect(dev?.subtaskCount).toBe(0);
    expect(dev?.isDefined).toBe(true);
  });

  it('Phase đã định nghĩa xếp theo displayOrder, không theo thứ tự truyền vào', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      // Cố tình truyền lộn xộn.
      definitions: [def('TEST', 3), def('DESIGN', 1), def('DEV', 2)],
      subtasks: [],
    });

    expect(res.groups.map((g) => g.phaseCode)).toEqual(['DESIGN', 'DEV', 'TEST']);
  });

  it('Sub-task gom đúng vào Phase của nó, đếm số lượng khớp', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      definitions: [def('DESIGN', 1), def('DEV', 2)],
      subtasks: [
        sub({ issueKey: 'S-1', phaseCode: 'DESIGN' }),
        sub({ issueKey: 'S-2', phaseCode: 'DEV' }),
        sub({ issueKey: 'S-3', phaseCode: 'DEV' }),
      ],
    });

    const dev = res.groups.find((g) => g.phaseCode === 'DEV');
    expect(dev?.subtaskCount).toBe(2);
    expect(dev?.tickets.map((t) => t.issueKey)).toEqual(['S-2', 'S-3']);
  });

  it('ticket trong nhóm sắp theo issueKey — thứ tự ổn định', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      definitions: [def('DESIGN', 1)],
      subtasks: [
        sub({ issueKey: 'PAY-30', phaseCode: 'DESIGN' }),
        sub({ issueKey: 'PAY-4', phaseCode: 'DESIGN' }),
        sub({ issueKey: 'PAY-12', phaseCode: 'DESIGN' }),
      ],
    });

    expect(res.groups[0]?.tickets.map((t) => t.issueKey)).toEqual(['PAY-12', 'PAY-30', 'PAY-4']);
  });

  it('mã Phase không khớp cấu hình nào gom thành nhóm ngoài luồng ở CUỐI', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      definitions: [def('DESIGN', 1)],
      subtasks: [
        sub({ issueKey: 'S-1', phaseCode: 'DESIGN' }),
        sub({ issueKey: 'S-2', phaseCode: 'MYSTERY' }),
      ],
    });

    const last = res.groups[res.groups.length - 1];
    expect(last?.phaseCode).toBe('MYSTERY');
    expect(last?.isDefined).toBe(false);
    expect(last?.label).toBeNull();
    expect(last?.colorHex).toBeNull();
  });

  it('UNCLASSIFIED luôn xếp DƯỚI CÙNG trong các nhóm ngoài luồng', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      definitions: [def('DESIGN', 1)],
      subtasks: [
        sub({ issueKey: 'S-1', phaseCode: 'UNCLASSIFIED' }),
        sub({ issueKey: 'S-2', phaseCode: 'ZETA' }),
        sub({ issueKey: 'S-3', phaseCode: 'ALPHA' }),
      ],
    });

    // DESIGN (định nghĩa) trước; rồi ALPHA, ZETA (chữ cái); UNCLASSIFIED cuối.
    expect(res.groups.map((g) => g.phaseCode)).toEqual(['DESIGN', 'ALPHA', 'ZETA', 'UNCLASSIFIED']);
  });

  it('đổi giây ước lượng sang giờ', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      definitions: [def('DESIGN', 1)],
      subtasks: [sub({ issueKey: 'S-1', phaseCode: 'DESIGN', originalEstimateSeconds: 5400 })],
    });

    expect(res.groups[0]?.tickets[0]?.originalEstimateHours).toBe(1.5);
  });

  it('đổi giây đã log sang giờ, giữ nguyên ngày thực tế', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      definitions: [def('DESIGN', 1)],
      subtasks: [
        sub({
          issueKey: 'S-1',
          phaseCode: 'DESIGN',
          actualStart: '2026-03-03',
          actualEnd: '2026-03-05',
          timeSpentSeconds: 9000,
        }),
      ],
    });

    const ticket = res.groups[0]?.tickets[0];
    expect(ticket?.actualStart).toBe('2026-03-03');
    expect(ticket?.actualEnd).toBe('2026-03-05');
    expect(ticket?.timeSpentHours).toBe(2.5);
  });

  it('đổi giây còn lại (remaining estimate) sang giờ', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      definitions: [def('DESIGN', 1)],
      subtasks: [sub({ issueKey: 'S-1', phaseCode: 'DESIGN', remainingEstimateSeconds: 12600 })],
    });

    expect(res.groups[0]?.tickets[0]?.remainingEstimateHours).toBe(3.5);
  });

  it('tổng Sub-task đếm hết mọi nhóm', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      definitions: [def('DESIGN', 1), def('DEV', 2)],
      subtasks: [
        sub({ issueKey: 'S-1', phaseCode: 'DESIGN' }),
        sub({ issueKey: 'S-2', phaseCode: 'DEV' }),
        sub({ issueKey: 'S-3', phaseCode: 'UNCLASSIFIED' }),
      ],
    });

    expect(res.totalSubtasks).toBe(3);
    const counted = res.groups.reduce((sum, g) => sum + g.subtaskCount, 0);
    expect(counted).toBe(3);
  });

  it('định nghĩa trùng mã chỉ ra MỘT nhóm (giữ bản displayOrder nhỏ hơn)', () => {
    const res = buildPhaseSubtaskList({
      epicKey: EPIC,
      definitions: [def('DESIGN', 1, { label: 'Kept' }), def('DESIGN', 9, { label: 'Dropped' })],
      subtasks: [],
    });

    const design = res.groups.filter((g) => g.phaseCode === 'DESIGN');
    expect(design).toHaveLength(1);
    expect(design[0]?.label).toBe('Kept');
  });

  it('Epic chưa có Phase định nghĩa lẫn Sub-task nào thì không có nhóm nào', () => {
    const res = buildPhaseSubtaskList({ epicKey: EPIC, definitions: [], subtasks: [] });
    expect(res.groups).toEqual([]);
    expect(res.totalSubtasks).toBe(0);
  });
});
