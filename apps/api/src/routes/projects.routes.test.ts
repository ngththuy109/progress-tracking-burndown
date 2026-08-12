import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fieldMappingConfigSchema } from '@app/jira';
import type { Principal } from '@app/shared';
import type {
  ProjectConnectionRow,
  ProjectMemberRow,
  ProjectRow,
  UpdateProjectJiraArgs,
  UpsertProjectArgs,
} from '@app/db';
import { registerProjectsRoutes } from './projects.routes.js';
import type { ProjectMemberStore, ProjectStore } from '../adapters/project.adapters.js';
import { asAdmin, asPm, asNobody, testGuards, FakeJiraTester, FAKE_TOKEN_BOX } from '../test-fakes.js';

/** Mô phỏng lỗi FK của Prisma — route chỉ nhìn `code === 'P2003'`. */
class FakeFkError extends Error {
  readonly code = 'P2003';
}

interface FakeProject {
  row: Omit<ProjectRow, 'hasJiraToken' | 'memberCount'>;
  jiraTokenEnc: string | null;
  jiraFieldsJson: unknown;
  jiraResolvedJson: unknown;
  /** true = còn Epic/issue trỏ vào → DELETE nổ FK. */
  inUse?: boolean;
}

class FakeProjectStore implements ProjectStore {
  readonly projects = new Map<string, FakeProject>();
  readonly members = new Map<string, ProjectMemberRow[]>();

  constructor(seed: FakeProject[]) {
    for (const p of seed) this.projects.set(p.row.projectKey, p);
  }

  private view(p: FakeProject): ProjectRow {
    return {
      ...p.row,
      hasJiraToken: p.jiraTokenEnc !== null,
      memberCount: (this.members.get(p.row.projectKey) ?? []).length,
    };
  }

  list(): Promise<readonly ProjectRow[]> {
    return Promise.resolve([...this.projects.values()].map((p) => this.view(p)));
  }
  find(projectKey: string): Promise<ProjectRow | null> {
    const p = this.projects.get(projectKey);
    return Promise.resolve(p === undefined ? null : this.view(p));
  }
  upsert(row: UpsertProjectArgs): Promise<void> {
    const existing = this.projects.get(row.projectKey);
    this.projects.set(row.projectKey, {
      jiraTokenEnc: existing?.jiraTokenEnc ?? null,
      jiraFieldsJson: existing?.jiraFieldsJson ?? null,
      jiraResolvedJson: existing?.jiraResolvedJson ?? null,
      row: {
        projectKey: row.projectKey,
        displayName: row.displayName,
        status: row.status ?? existing?.row.status ?? 'ACTIVE',
        jiraBaseUrl: existing?.row.jiraBaseUrl ?? null,
        jiraEmail: existing?.row.jiraEmail ?? null,
        hierarchyDepth: row.hierarchyDepth ?? existing?.row.hierarchyDepth ?? 2,
        timezone: row.timezone ?? existing?.row.timezone ?? 'Asia/Ho_Chi_Minh',
        defaultCalendarId: row.defaultCalendarId ?? existing?.row.defaultCalendarId ?? null,
      },
    });
    return Promise.resolve();
  }
  updateJira(projectKey: string, args: UpdateProjectJiraArgs): Promise<boolean> {
    const p = this.projects.get(projectKey);
    if (p === undefined) return Promise.resolve(false);
    p.row = { ...p.row, jiraBaseUrl: args.jiraBaseUrl, jiraEmail: args.jiraEmail };
    if (args.jiraTokenEnc !== undefined) p.jiraTokenEnc = args.jiraTokenEnc;
    p.jiraFieldsJson = args.jiraFieldsJson;
    if (args.jiraResolvedJson !== undefined) p.jiraResolvedJson = args.jiraResolvedJson;
    return Promise.resolve(true);
  }
  remove(projectKey: string): Promise<boolean> {
    const p = this.projects.get(projectKey);
    if (p?.inUse) return Promise.reject(new FakeFkError('FK violation'));
    return Promise.resolve(this.projects.delete(projectKey));
  }
  connection(projectKey: string): Promise<ProjectConnectionRow | null> {
    const p = this.projects.get(projectKey);
    if (p === undefined) return Promise.resolve(null);
    return Promise.resolve({
      projectKey: p.row.projectKey,
      status: p.row.status,
      jiraBaseUrl: p.row.jiraBaseUrl,
      jiraEmail: p.row.jiraEmail,
      jiraTokenEnc: p.jiraTokenEnc,
      jiraFieldsJson: p.jiraFieldsJson,
      jiraResolvedJson: p.jiraResolvedJson,
      hierarchyDepth: p.row.hierarchyDepth,
      timezone: p.row.timezone,
    });
  }
}

class FakeMemberStore implements ProjectMemberStore {
  /** Email đã có trong app_user — thêm người ngoài danh sách này nổ FK. */
  readonly provisioned = new Set(['pm@x.com', 'viewer@x.com', 'admin@x.com']);
  constructor(private readonly store: FakeProjectStore) {}

  list(projectKey: string): Promise<readonly ProjectMemberRow[]> {
    return Promise.resolve(this.store.members.get(projectKey) ?? []);
  }
  upsert(args: { projectKey: string; userId: string; role: 'PM' | 'VIEWER'; addedBy: string }): Promise<void> {
    if (!this.provisioned.has(args.userId)) return Promise.reject(new FakeFkError('FK violation'));
    const rows = this.store.members.get(args.projectKey) ?? [];
    const existing = rows.find((r) => r.userId === args.userId);
    if (existing) {
      (existing as { role: string }).role = args.role;
    } else {
      rows.push({
        userId: args.userId,
        role: args.role,
        displayName: null,
        addedBy: args.addedBy,
        addedAt: new Date('2026-08-01T00:00:00.000Z'),
      });
    }
    this.store.members.set(args.projectKey, rows);
    return Promise.resolve();
  }
  remove(projectKey: string, userId: string): Promise<boolean> {
    const rows = this.store.members.get(projectKey) ?? [];
    const next = rows.filter((r) => r.userId !== userId);
    this.store.members.set(projectKey, next);
    return Promise.resolve(next.length !== rows.length);
  }
}

const FIELDS_CONFIG = { fieldMapping: { wbsStartDate: 'customfield_1', wbsEndDate: 'customfield_2' } };

function project(projectKey: string, over: Partial<FakeProject> = {}): FakeProject {
  return {
    row: {
      projectKey,
      displayName: `Dự án ${projectKey}`,
      status: 'ACTIVE',
      jiraBaseUrl: null,
      jiraEmail: null,
      hierarchyDepth: 2,
      timezone: 'Asia/Ho_Chi_Minh',
      defaultCalendarId: null,
    },
    jiraTokenEnc: null,
    jiraFieldsJson: null,
    jiraResolvedJson: null,
    ...over,
  };
}

let principal: Principal | null;
let store: FakeProjectStore;
let members: FakeMemberStore;
let tester: FakeJiraTester;
let app: FastifyInstance;

const ENV_JIRA = {
  baseUrl: 'https://env.atlassian.net',
  email: 'env@x.com',
  apiToken: 'env-token',
  fieldsConfig: FIELDS_CONFIG,
};

function build(
  seed: FakeProject[] = [project('PAY'), project('CRM')],
  opts: { tokenBox?: typeof FAKE_TOKEN_BOX | null; envJira?: typeof ENV_JIRA | null } = {},
): FastifyInstance {
  store = new FakeProjectStore(seed);
  members = new FakeMemberStore(store);
  tester = new FakeJiraTester();
  const instance = Fastify({ logger: false });
  registerProjectsRoutes(instance, {
    resolvePrincipal: () => principal,
    guards: testGuards({ principal: () => principal }),
    projects: store,
    members,
    tokenBox: opts.tokenBox === undefined ? FAKE_TOKEN_BOX : opts.tokenBox,
    jiraTester: tester,
    envJira: opts.envJira === undefined ? ENV_JIRA : opts.envJira,
    validateFieldsConfig: (v) => {
      const parsed = fieldMappingConfigSchema.safeParse(v);
      return parsed.success ? { ok: true } : { ok: false, message: 'sai cấu trúc' };
    },
  });
  return instance;
}

beforeEach(() => {
  principal = asAdmin();
  app = build();
});

describe('phân quyền nhóm /api/admin/projects', () => {
  it('không đăng nhập → 401; không phải ADMIN → 403 (kể cả PM)', async () => {
    principal = null;
    expect((await app.inject({ method: 'GET', url: '/api/admin/projects' })).statusCode).toBe(401);

    for (const p of [asPm('PAY'), asNobody()]) {
      principal = p;
      const res = await app.inject({ method: 'GET', url: '/api/admin/projects' });
      expect(res.statusCode, p.userId).toBe(403);
    }
  });
});

describe('GET/PUT/DELETE /api/admin/projects', () => {
  it('GET liệt kê tenant theo projectSchema (không bao giờ có token)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/projects' });
    expect(res.statusCode).toBe(200);
    const projects = res.json().projects as Array<Record<string, unknown>>;
    expect(projects.map((p) => p['projectKey'])).toEqual(['PAY', 'CRM']);
    expect(projects[0]).toMatchObject({ hasJiraToken: false, memberCount: 0, status: 'ACTIVE' });
    expect(JSON.stringify(projects)).not.toContain('TokenEnc');
  });

  it('PUT đăng ký tenant mới — key trong URL thắng key trong body', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/new',
      payload: { projectKey: 'HACK', displayName: 'Tenant mới', hierarchyDepth: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ projectKey: 'NEW', displayName: 'Tenant mới', hierarchyDepth: 3 });
    expect(store.projects.has('NEW')).toBe(true);
    expect(store.projects.has('HACK')).toBe(false);
  });

  it('PUT với key sai định dạng → 400', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/projects/1BAD', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE tenant trống → ok; tenant còn dữ liệu (FK) → 409 PROJECT_IN_USE', async () => {
    app = build([project('PAY', { inUse: true }), project('CRM')]);
    principal = asAdmin();

    expect((await app.inject({ method: 'DELETE', url: '/api/admin/projects/CRM' })).statusCode).toBe(200);

    const res = await app.inject({ method: 'DELETE', url: '/api/admin/projects/PAY' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('PROJECT_IN_USE');
    expect(store.projects.has('PAY')).toBe(true);
  });

  it('DELETE tenant không tồn tại → 404', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/projects/NOPE' })).statusCode).toBe(404);
  });
});

describe('PUT /api/admin/projects/:projectKey/jira', () => {
  it('token được MÃ HÓA trước khi lưu và KHÔNG BAO GIỜ echo lại', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/jira',
      payload: {
        jiraBaseUrl: 'https://pay.atlassian.net',
        jiraEmail: 'svc@pay.com',
        apiToken: 'super-secret',
        fieldsConfig: FIELDS_CONFIG,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(store.projects.get('PAY')?.jiraTokenEnc).toBe('sealed(super-secret)');
    // Response chỉ có cờ hasJiraToken; token thô không xuất hiện ở đâu.
    expect(res.json()).toMatchObject({ hasJiraToken: true, jiraBaseUrl: 'https://pay.atlassian.net' });
    expect(res.body).not.toContain('super-secret');
  });

  it('không gửi apiToken = GIỮ token cũ (khi base URL KHÔNG đổi); apiToken null = XÓA', async () => {
    const seeded = project('PAY', { jiraTokenEnc: 'sealed(old)' });
    (seeded.row as { jiraBaseUrl: string | null }).jiraBaseUrl = 'https://a.atlassian.net';
    app = build([seeded]);
    principal = asAdmin();

    const keep = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/jira',
      payload: { jiraBaseUrl: 'https://a.atlassian.net', jiraEmail: 'a@x.com' },
    });
    expect(keep.statusCode).toBe(200);
    expect(store.projects.get('PAY')?.jiraTokenEnc).toBe('sealed(old)');

    const clear = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/jira',
      payload: { jiraBaseUrl: 'https://a.atlassian.net', apiToken: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(store.projects.get('PAY')?.jiraTokenEnc).toBeNull();
    expect(clear.json().hasJiraToken).toBe(false);
  });

  it('đổi base URL mà không nhập token mới → token đã lưu bị TỰ XÓA (chống trỏ URL sang server lạ)', async () => {
    const seeded = project('PAY', { jiraTokenEnc: 'sealed(old)' });
    (seeded.row as { jiraBaseUrl: string | null }).jiraBaseUrl = 'https://a.atlassian.net';
    app = build([seeded]);
    principal = asAdmin();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/jira',
      payload: { jiraBaseUrl: 'https://evil.example.com', jiraEmail: 'a@x.com' },
    });
    expect(res.statusCode).toBe(200);
    // Token cũ KHÔNG được phép đi theo URL mới.
    expect(store.projects.get('PAY')?.jiraTokenEnc).toBeNull();
    expect(res.json().hasJiraToken).toBe(false);
  });

  it('đổi base URL KÈM token mới → lưu token mới bình thường (SET, không auto-clear)', async () => {
    const seeded = project('PAY', { jiraTokenEnc: 'sealed(old)' });
    (seeded.row as { jiraBaseUrl: string | null }).jiraBaseUrl = 'https://a.atlassian.net';
    app = build([seeded]);
    principal = asAdmin();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/jira',
      payload: { jiraBaseUrl: 'https://b.atlassian.net', apiToken: 'new-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.projects.get('PAY')?.jiraTokenEnc).toBe('sealed(new-secret)');
  });

  it('gửi token khi APP_ENCRYPTION_KEY chưa đặt → 400 rõ ràng, KHÔNG lưu thô', async () => {
    app = build(undefined, { tokenBox: null });
    principal = asAdmin();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/jira',
      payload: { apiToken: 'secret' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ENCRYPTION_KEY_MISSING');
    expect(res.json().message).toContain('APP_ENCRYPTION_KEY');
    expect(store.projects.get('PAY')?.jiraTokenEnc).toBeNull();
  });

  it('fieldsConfig sai cấu trúc → 400, không ghi gì', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/jira',
      payload: { fieldsConfig: { sai: true } },
    });
    expect(res.statusCode).toBe(400);
    expect(store.projects.get('PAY')?.jiraFieldsJson).toBeNull();
  });

  it('tenant không tồn tại → 404', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/projects/NOPE/jira', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/admin/projects/:projectKey/jira/test', () => {
  it('body ghi đè → DB → env: giá trị hiệu lực được đưa cho tester', async () => {
    app = build([
      project('PAY', {
        row: { ...project('PAY').row, jiraBaseUrl: 'https://db.atlassian.net', jiraEmail: 'db@x.com' },
        jiraTokenEnc: 'sealed(db-token)',
        jiraFieldsJson: FIELDS_CONFIG,
      }),
    ]);
    principal = asAdmin();

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/projects/PAY/jira/test',
      payload: { jiraEmail: 'override@x.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(tester.calls).toHaveLength(1);
    expect(tester.calls[0]).toEqual({
      baseUrl: 'https://db.atlassian.net', // DB (body không ghi đè)
      email: 'override@x.com', // body thắng
      apiToken: 'db-token', // token đã lưu được GIẢI MÃ rồi đưa cho tester
      fieldsConfig: FIELDS_CONFIG,
      projectKey: 'PAY',
    });
  });

  it('tenant chưa khai gì → rơi hết về env JIRA_*', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/projects/CRM/jira/test', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(tester.calls[0]).toMatchObject({
      baseUrl: ENV_JIRA.baseUrl,
      email: ENV_JIRA.email,
      apiToken: ENV_JIRA.apiToken,
      projectKey: 'CRM',
    });
  });

  it('không env, không cấu hình riêng → tester nhận null (tự trả bước AUTH hỏng)', async () => {
    app = build(undefined, { envJira: null });
    principal = asAdmin();
    const res = await app.inject({ method: 'POST', url: '/api/admin/projects/PAY/jira/test', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(tester.calls[0]).toMatchObject({ baseUrl: null, email: null, apiToken: null });
  });
});

describe('thành viên dự án — /api/admin/projects/:projectKey/members', () => {
  it('PUT thêm thành viên rồi GET thấy đúng role, addedAt là ISO string', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/members',
      payload: { userId: 'PM@X.com', role: 'PM' },
    });
    expect(put.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/admin/projects/PAY/members' });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual([
      {
        userId: 'pm@x.com', // chuẩn hoá chữ thường
        role: 'PM',
        displayName: null,
        addedBy: 'admin@x.com',
        addedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
  });

  it('user chưa được cấp ở /api/admin/users (FK) → 400 USER_NOT_PROVISIONED', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/members',
      payload: { userId: 'stranger@x.com', role: 'VIEWER' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('USER_NOT_PROVISIONED');
  });

  it('role ngoài PM/VIEWER → 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/members',
      payload: { userId: 'pm@x.com', role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /members/:userId gỡ thành viên; gỡ người không có → 404', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/admin/projects/PAY/members',
      payload: { userId: 'viewer@x.com', role: 'VIEWER' },
    });

    const ok = await app.inject({ method: 'DELETE', url: '/api/admin/projects/PAY/members/viewer@x.com' });
    expect(ok.statusCode).toBe(200);

    const gone = await app.inject({ method: 'DELETE', url: '/api/admin/projects/PAY/members/viewer@x.com' });
    expect(gone.statusCode).toBe(404);
  });

  it('dự án không tồn tại → 404 cho cả GET/PUT/DELETE', async () => {
    for (const r of [
      { method: 'GET' as const, url: '/api/admin/projects/NOPE/members' },
      { method: 'PUT' as const, url: '/api/admin/projects/NOPE/members', payload: { userId: 'pm@x.com', role: 'PM' } },
      { method: 'DELETE' as const, url: '/api/admin/projects/NOPE/members/pm@x.com' },
    ]) {
      expect((await app.inject(r)).statusCode, `${r.method} ${r.url}`).toBe(404);
    }
  });
});
