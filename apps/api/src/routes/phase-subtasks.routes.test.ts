import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PhaseSubtaskResponse, Principal } from '@app/shared';
import { registerPhaseSubtaskRoutes, type PhaseSubtaskReadPort } from './phase-subtasks.routes.js';
import type { LoadedSubtask, PhaseDefinitionLite } from '../services/phase-subtasks.service.js';

const ADMIN: Principal = { userId: 'admin', role: 'ADMIN', projects: [] };

function sub(over: Partial<LoadedSubtask> & { issueKey: string; phaseCode: string }): LoadedSubtask {
  return {
    summary: `Việc ${over.issueKey}`,
    parentKey: 'PAY-100',
    statusCategory: 'new',
    planStart: '2026-03-02',
    planEnd: '2026-03-06',
    originalEstimateSeconds: 3600,
    functionName: 'Login',
    taskType: 'Create',
    ...over,
  };
}

class FakeReads implements PhaseSubtaskReadPort {
  subtaskList: LoadedSubtask[] = [];
  definitionList: PhaseDefinitionLite[] = [
    { phaseCode: 'DESIGN', label: 'Thiết kế', colorHex: '#123456', displayOrder: 1 },
    { phaseCode: 'DEV', label: 'Phát triển', colorHex: null, displayOrder: 2 },
  ];
  meta: { projectKey: string } | null = { projectKey: 'PAY' };
  subtaskQueries = 0;

  async epicMeta() {
    return this.meta;
  }
  async subtasks() {
    this.subtaskQueries += 1;
    return this.subtaskList;
  }
  async phaseDefinitions() {
    return this.definitionList;
  }
}

let reads: FakeReads;
let app: FastifyInstance;
let principal: Principal | null;

beforeEach(async () => {
  reads = new FakeReads();
  principal = ADMIN;

  app = Fastify();
  registerPhaseSubtaskRoutes(app, { reads, resolvePrincipal: () => principal });
  await app.ready();
});

async function get<T>(url: string) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T & { error?: string; message?: string } };
}

const URL = '/api/epic/PAY-1/phase-subtasks';

describe('dựng danh sách', () => {
  it('trả về mọi Phase đã định nghĩa, kèm ticket bên trong', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', phaseCode: 'DESIGN' }),
      sub({ issueKey: 'S-2', phaseCode: 'DEV' }),
    ];

    const { status, body } = await get<PhaseSubtaskResponse>(URL);

    expect(status).toBe(200);
    expect(body.epicKey).toBe('PAY-1');
    expect(body.groups.map((g) => g.phaseCode)).toEqual(['DESIGN', 'DEV']);
    expect(body.groups[0]?.label).toBe('Thiết kế');
    expect(body.groups[0]?.colorHex).toBe('#123456');
    expect(body.groups[0]?.tickets.map((t) => t.issueKey)).toEqual(['S-1']);
    expect(body.totalSubtasks).toBe(2);
  });

  it('Phase định nghĩa mà chưa có ticket vẫn hiện dưới dạng nhóm rỗng', async () => {
    reads.subtaskList = [sub({ issueKey: 'S-1', phaseCode: 'DESIGN' })];
    const { body } = await get<PhaseSubtaskResponse>(URL);

    const dev = body.groups.find((g) => g.phaseCode === 'DEV');
    expect(dev?.subtaskCount).toBe(0);
    expect(dev?.tickets).toEqual([]);
  });

  it('ticket mang mã Phase lạ gom thành nhóm ngoài luồng ở cuối', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', phaseCode: 'DESIGN' }),
      sub({ issueKey: 'S-9', phaseCode: 'UNCLASSIFIED' }),
    ];

    const { body } = await get<PhaseSubtaskResponse>(URL);
    const last = body.groups[body.groups.length - 1];

    expect(last?.phaseCode).toBe('UNCLASSIFIED');
    expect(last?.isDefined).toBe(false);
    expect(last?.tickets.map((t) => t.issueKey)).toEqual(['S-9']);
  });

  it('đổi giây ước lượng sang giờ trong ticket trả về', async () => {
    reads.subtaskList = [sub({ issueKey: 'S-1', phaseCode: 'DESIGN', originalEstimateSeconds: 7200 })];
    const { body } = await get<PhaseSubtaskResponse>(URL);

    expect(body.groups[0]?.tickets[0]?.originalEstimateHours).toBe(2);
  });

  it('chỉ chạy MỘT truy vấn lấy Sub-task', async () => {
    reads.subtaskList = [sub({ issueKey: 'S-1', phaseCode: 'DESIGN' })];
    await get<PhaseSubtaskResponse>(URL);

    expect(reads.subtaskQueries).toBe(1);
  });
});

describe('phân quyền và lỗi', () => {
  it('Epic không có trong sổ theo dõi nhận HTTP 404', async () => {
    reads.meta = null;
    expect((await get(URL)).status).toBe(404);
  });

  it('PM không phụ trách project nhận HTTP 403', async () => {
    principal = { userId: 'pm', role: 'PM', projects: ['SHOP'] };
    expect((await get(URL)).status).toBe(403);
  });

  it('PM phụ trách đúng project xem được', async () => {
    principal = { userId: 'pm', role: 'PM', projects: ['PAY'] };
    expect((await get(URL)).status).toBe(200);
  });

  it('VIEWER xem được mọi Epic', async () => {
    principal = { userId: 'v', role: 'VIEWER', projects: [] };
    expect((await get(URL)).status).toBe(200);
  });

  it('thiếu thông tin người dùng nhận HTTP 401', async () => {
    principal = null;
    expect((await get(URL)).status).toBe(401);
  });
});
