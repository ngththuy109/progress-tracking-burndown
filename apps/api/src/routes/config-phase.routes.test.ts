import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ConfigPayload, Principal, PreviewResponse } from '@app/shared';
import { registerConfigPhaseRoutes } from './config-phase.routes.js';
import { FakeConfigStore, FakeDirtyQueue, FakeIssueRead } from '../test-fakes.js';
import type { PreviewTask } from '../services/config-preview.service.js';

const GLOBAL_PAYLOAD: ConfigPayload = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[Phase] {name}', sortOrder: 1 }],
  subtaskPatterns: [
    { patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 },
  ],
  phaseDefinitions: [
    { phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 1 },
    { phaseCode: 'TESTING', labelVi: 'Kiểm thử', displayOrder: 2 },
  ],
  matchRules: [{ keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 }],
  signboardColumns: [{ taskCode: 'Create', labelVi: 'Tạo mới', displayOrder: 1 }],
};

const TASKS: PreviewTask[] = [
  { taskKey: 'PAY-101', epicKey: 'PAY-100', title: '[Phase] Design', currentPhaseCode: 'DESIGN' },
  {
    taskKey: 'PAY-102',
    epicKey: 'PAY-100',
    title: '[Phase] Design Review',
    currentPhaseCode: 'DESIGN',
  },
  { taskKey: 'PAY-107', epicKey: 'PAY-200', title: '打ち合わせ準備', currentPhaseCode: 'UNCLASSIFIED' },
];

const ADMIN: Principal = { userId: 'admin@x.com', role: 'ADMIN', projects: [] };
const PM_PAY: Principal = { userId: 'pm@x.com', role: 'PM', projects: ['PAY'] };
const VIEWER: Principal = { userId: 'v@x.com', role: 'VIEWER', projects: [] };

let store: FakeConfigStore;
let dirty: FakeDirtyQueue;
let principal: Principal | null;

function build(tasks: readonly PreviewTask[] = TASKS, epicKeys: readonly string[] = ['PAY-100', 'PAY-200']): FastifyInstance {
  store = new FakeConfigStore([
    { scope: 'GLOBAL', projectKey: null, payload: GLOBAL_PAYLOAD, note: 'bản đầu' },
  ]);
  dirty = new FakeDirtyQueue();
  const app = Fastify({ logger: false });
  registerConfigPhaseRoutes(app, {
    store,
    dirty,
    issues: new FakeIssueRead(
      tasks,
      [
        { rawPhaseLabel: 'Chuẩn bị họp', count: 7, sampleTaskKeys: ['PAY-107'] },
        { rawPhaseLabel: '結合テスト', count: 12, sampleTaskKeys: ['PAY-140'] },
      ],
      epicKeys,
    ),
    resolvePrincipal: () => principal,
  });
  return app;
}

let app: FastifyInstance;
beforeEach(() => {
  principal = ADMIN;
  app = build();
});

/** Bản nháp thêm luật "Design Review" ưu tiên cao hơn → PAY-102 đổi sang TESTING. */
const DRAFT_WITH_REVIEW: ConfigPayload = {
  ...GLOBAL_PAYLOAD,
  matchRules: [
    { keyword: 'Design Review', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 10 },
    { keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
  ],
};

const previewBody = (draft: ConfigPayload, projectKey: string | null = null) =>
  ({ method: 'POST' as const, url: '/api/config/phase/preview', payload: { projectKey, draft } });

describe('xem thử', () => {
  it('xem thử KHÔNG ghi gì vào database', async () => {
    const before = store.writeCount;
    const res = await app.inject(previewBody(DRAFT_WITH_REVIEW));
    expect(res.statusCode).toBe(200);
    expect(store.writeCount).toBe(before);
    expect(store.writeCount).toBe(0);
  });

  it('xem thử trả về đúng luật đã thắng cho từng Task', async () => {
    const res = await app.inject(previewBody(DRAFT_WITH_REVIEW));
    const body = res.json<PreviewResponse>();

    const row102 = body.rows.find((r) => r.taskKey === 'PAY-102')!;
    expect(row102.winningRule).toEqual({ keyword: 'Design Review', mode: 'CONTAINS', priority: 10 });
    expect(row102.matchedPattern).toBe('[Phase] {name}');
    expect(row102.extractedName).toBe('Design Review');

    const row101 = body.rows.find((r) => r.taskKey === 'PAY-101')!;
    expect(row101.winningRule?.keyword).toBe('Design');
  });

  it('Task đổi phân loại được đánh dấu status = CHANGED', async () => {
    const body = (await app.inject(previewBody(DRAFT_WITH_REVIEW))).json<PreviewResponse>();
    const row = body.rows.find((r) => r.taskKey === 'PAY-102')!;
    expect(row.status).toBe('CHANGED');
    expect(row.previousPhaseCode).toBe('DESIGN');
    expect(row.resultPhaseCode).toBe('TESTING');
    expect(row.resultLabel).toBe('Kiểm thử');
  });

  it('Task vẫn không nhận diện được đánh dấu STILL_UNCLASSIFIED', async () => {
    const body = (await app.inject(previewBody(DRAFT_WITH_REVIEW))).json<PreviewResponse>();
    const row = body.rows.find((r) => r.taskKey === 'PAY-107')!;
    expect(row.status).toBe('STILL_UNCLASSIFIED');
    expect(row.resultPhaseCode).toBe('UNCLASSIFIED');
    expect(row.resultLabel).toBe('Unclassified');
    expect(row.matchedPattern).toBeNull();
    expect(row.winningRule).toBeNull();
  });

  it('phần summary đếm đúng số Epic bị ảnh hưởng', async () => {
    const body = (await app.inject(previewBody(DRAFT_WITH_REVIEW))).json<PreviewResponse>();
    expect(body.totalTasks).toBe(3);
    expect(body.summary).toEqual({
      unchanged: 1, //  PAY-101 giữ DESIGN
      changed: 1, //    PAY-102 sang TESTING
      stillUnclassified: 1, // PAY-107
      affectedEpics: 1, //  chỉ PAY-100 có Task đổi; PAY-200 không đổi gì
      estimatedRecomputeSeconds: 40,
    });
  });

  it('cấu hình nháp có regex ReDoS thì xem thử vẫn trả về trong dưới 2 giây', async () => {
    const bomb: ConfigPayload = {
      ...GLOBAL_PAYLOAD,
      matchRules: [
        { keyword: '(a+)+$', matchMode: 'REGEX', phaseCode: 'DESIGN', matchPriority: 10 },
      ],
    };
    const evil = Array.from({ length: 30 }, (_, i) => ({
      taskKey: `PAY-${900 + i}`,
      epicKey: 'PAY-100',
      title: '[Phase] ' + 'a'.repeat(40) + 'b',
      currentPhaseCode: 'UNCLASSIFIED',
    }));

    const local = build(evil);
    const started = performance.now();
    const res = await local.inject(previewBody(bomb));
    expect(res.statusCode).toBe(200);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('xem thử bản nháp của project vẫn gộp kế thừa từ bộ Mặc định', async () => {
    // Bản nháp CHỈ sửa luật khớp, bỏ trống danh sách Phase. Không gộp kế thừa
    // thì mọi Task sẽ ra UNCLASSIFIED — xem thử nói dối so với lúc lưu thật.
    const partial = { ...GLOBAL_PAYLOAD, phaseDefinitions: [], titlePatterns: [] };
    const body = (await app.inject(previewBody(partial, 'PAY'))).json<PreviewResponse>();
    expect(body.rows.find((r) => r.taskKey === 'PAY-101')!.resultPhaseCode).toBe('DESIGN');
    expect(body.summary.stillUnclassified).toBe(1); // chỉ PAY-107
  });
});

describe('lưu', () => {
  it('lưu thành công tạo version mới và trả về số Epic phải tính lại', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: null, payload: DRAFT_WITH_REVIEW, note: 'thêm Design Review' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: 2,
      affectedEpics: 2,
      estimatedRecomputeSeconds: 80,
    });
  });

  it('lưu thành công đẩy đúng các Epic vào Redis set dirty:epics', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: null, payload: DRAFT_WITH_REVIEW, note: null },
    });
    expect([...dirty.members].sort()).toEqual(['PAY-100', 'PAY-200']);
  });

  it('cấu hình không hợp lệ bị từ chối với HTTP 400 và mã lỗi ORPHAN_PHASE_CODE', async () => {
    const broken: ConfigPayload = {
      ...GLOBAL_PAYLOAD,
      matchRules: [
        { keyword: 'Dev', matchMode: 'CONTAINS', phaseCode: 'KHONG_TON_TAI', matchPriority: 50 },
      ],
    };
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: null, payload: broken, note: null },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('CONFIG_INVALID');
    expect(body.issues.some((i: { code: string }) => i.code === 'ORPHAN_PHASE_CODE')).toBe(true);
  });

  it('lưu thất bại thì KHÔNG có version mới nào được tạo', async () => {
    const broken: ConfigPayload = { ...GLOBAL_PAYLOAD, phaseDefinitions: [] };
    await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: null, payload: broken, note: null },
    });
    expect(store.writeCount).toBe(0);

    const versions = (await app.inject({ method: 'GET', url: '/api/config/phase/versions' })).json();
    expect(versions.versions).toHaveLength(1);
  });

  it('lưu thất bại thì KHÔNG đẩy Epic nào vào dirty:epics', async () => {
    const broken: ConfigPayload = { ...GLOBAL_PAYLOAD, phaseDefinitions: [] };
    await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: null, payload: broken, note: null },
    });
    expect(dirty.members.size).toBe(0);
  });
});

describe('version và quay lại', () => {
  it('GET /versions trả đủ lịch sử kèm người sửa và ghi chú', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: null, payload: DRAFT_WITH_REVIEW, note: 'thêm Design Review' },
    });
    const body = (await app.inject({ method: 'GET', url: '/api/config/phase/versions' })).json();

    expect(body.versions).toHaveLength(2);
    expect(body.versions[0]).toMatchObject({
      version: 2,
      isActive: true,
      createdBy: 'admin@x.com',
      note: 'thêm Design Review',
    });
    expect(body.versions[1]).toMatchObject({ version: 1, isActive: false, note: 'bản đầu' });
  });

  it('rollback về version 1 tạo version mới, version 2 vẫn còn trong lịch sử', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: null, payload: DRAFT_WITH_REVIEW, note: 'v2' },
    });
    const res = await app.inject({ method: 'POST', url: '/api/config/phase/rollback/1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(3);

    const body = (await app.inject({ method: 'GET', url: '/api/config/phase/versions' })).json();
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    // Quay lại KHÔNG xoá version 2 — viết lại lịch sử thì không giải thích được
    expect(body.versions.find((v: { version: number }) => v.version === 2)).toBeDefined();
  });

  it('rollback cũng đẩy Epic vào dirty:epics', async () => {
    await app.inject({ method: 'POST', url: '/api/config/phase/rollback/1' });
    expect([...dirty.members].sort()).toEqual(['PAY-100', 'PAY-200']);
  });

  it('rollback về version không tồn tại trả HTTP 500 chứ không im lặng', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/config/phase/rollback/99' });
    expect(res.statusCode).toBe(500);
  });
});

describe('kế thừa và phân quyền', () => {
  it('GET /api/config/phase?project=SHOP trả cấu hình đã gộp kèm cờ inherited đúng từng phần', async () => {
    store = new FakeConfigStore([
      { scope: 'GLOBAL', projectKey: null, payload: GLOBAL_PAYLOAD },
      {
        scope: 'PROJECT',
        projectKey: 'SHOP',
        // SHOP chỉ ghi đè mẫu tiêu đề. Phần còn lại PHẢI kế thừa.
        payload: { ...GLOBAL_PAYLOAD, titlePatterns: [{ patternText: '【{name}】', sortOrder: 1 }], phaseDefinitions: [], matchRules: [], signboardColumns: [], subtaskPatterns: [] },
      },
    ]);
    const local = Fastify({ logger: false });
    registerConfigPhaseRoutes(local, {
      store,
      dirty: new FakeDirtyQueue(),
      issues: new FakeIssueRead(),
      resolvePrincipal: () => ADMIN,
    });

    const body = (await local.inject({ method: 'GET', url: '/api/config/phase?project=SHOP' })).json();
    expect(body.titlePatterns).toEqual([{ patternText: '【{name}】', sortOrder: 1 }]);
    expect(body.inherited.titlePatterns).toBe(false);
    expect(body.inherited.phaseDefinitions).toBe(true);
    expect(body.inherited.matchRules).toBe(true);
    expect(body.phaseDefinitions).toHaveLength(2); // kế thừa từ Mặc định
  });

  it('người dùng thường không được PUT, trả HTTP 403', async () => {
    principal = VIEWER;
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: 'PAY', payload: GLOBAL_PAYLOAD, note: null },
    });
    expect(res.statusCode).toBe(403);
    expect(store.writeCount).toBe(0);
  });

  it('PM sửa được project mình phụ trách nhưng KHÔNG sửa được bộ Mặc định', async () => {
    principal = PM_PAY;
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: 'PAY', payload: GLOBAL_PAYLOAD, note: null },
    });
    expect(ok.statusCode).toBe(200);

    const denied = await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: null, payload: GLOBAL_PAYLOAD, note: null },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('PM không sửa được project của người khác', async () => {
    principal = PM_PAY;
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: 'SHOP', payload: GLOBAL_PAYLOAD, note: null },
    });
    expect(res.statusCode).toBe(403);
  });

  it('yêu cầu không có thông tin người dùng trả HTTP 401', async () => {
    principal = null;
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/phase',
      payload: { projectKey: 'PAY', payload: GLOBAL_PAYLOAD, note: null },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('chưa nhận diện', () => {
  it('GET /unmatched trả danh sách raw_phase_label kèm số lần xuất hiện', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/config/phase/unmatched?project=PAY' })).json();
    expect(body.labels).toEqual([
      { rawPhaseLabel: 'Chuẩn bị họp', count: 7, sampleTaskKeys: ['PAY-107'] },
      { rawPhaseLabel: '結合テスト', count: 12, sampleTaskKeys: ['PAY-140'] },
    ]);
  });
});

describe('kiểm tra thân yêu cầu', () => {
  it('thân yêu cầu sai schema trả HTTP 400 kèm đường dẫn tới trường lỗi', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/phase/preview',
      payload: { projectKey: null, draft: { titlePatterns: 'không phải mảng' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
    expect(res.json().issues.length).toBeGreaterThan(0);
  });

  it('số version không phải số trả HTTP 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/config/phase/rollback/abc' });
    expect(res.statusCode).toBe(400);
  });
});
