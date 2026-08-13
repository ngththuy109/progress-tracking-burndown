import { describe, it, expect } from 'vitest';
import { BasicAuthProvider, JiraClient, type JiraIssue, type ResolvedFieldMapping } from '@app/jira';
import { resolveParticipantNames } from './resolve-participant-names.js';

/**
 * Tra tên PIC — điểm mấu chốt: CHỈ hỏi Jira những accountId field KHÔNG kèm tên,
 * và lỗi tra tên KHÔNG được làm hỏng đồng bộ (trả về cảnh báo, không ném).
 */

const CREDS = {
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'svc@example.com',
  JIRA_API_TOKEN: 'secret-token-123',
};

const FIELDS: ResolvedFieldMapping = {
  wbsStartDate: 'customfield_10100',
  wbsEndDate: 'customfield_10101',
  requestParticipants: 'customfield_10400',
};

function client(fetchImpl: typeof fetch): JiraClient {
  return new JiraClient({
    credentials: new BasicAuthProvider(CREDS as unknown as NodeJS.ProcessEnv),
    fetchImpl,
    retry: { sleep: async () => {}, random: () => 0.5 },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function subtask(participants: unknown): JiraIssue {
  return { id: '1', key: 'PAY-1', fields: { customfield_10400: participants } };
}

describe('resolveParticipantNames', () => {
  it('field chưa cấu hình → không gọi Jira, map rỗng', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return json({ values: [], isLast: true });
    });
    const r = await resolveParticipantNames(c, [subtask(['u1'])], {
      wbsStartDate: 'a',
      wbsEndDate: 'b',
    });
    expect(r.names.size).toBe(0);
    expect(calls).toBe(0);
  });

  it('field đã kèm tên cho MỌI người → KHÔNG gọi /user/bulk', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return json({ values: [], isLast: true });
    });
    const r = await resolveParticipantNames(
      c,
      [subtask([{ accountId: 'u1', displayName: 'An' }])],
      FIELDS,
    );
    expect(calls).toBe(0);
    expect(r.names.get('u1')).toBe('An');
  });

  it('chỉ hỏi Jira những accountId THIẾU tên', async () => {
    const asked: string[] = [];
    const c = client(async (input) => {
      asked.push(...new URL(String(input)).searchParams.getAll('accountId'));
      return json({ values: [{ accountId: 'u2', displayName: 'Trần Bình' }], isLast: true });
    });

    const r = await resolveParticipantNames(
      c,
      [
        subtask([
          { accountId: 'u1', displayName: 'An' }, // đã có tên → không hỏi
          { accountId: 'u2' }, // thiếu tên → hỏi
        ]),
      ],
      FIELDS,
    );

    expect(asked).toEqual(['u2']);
    expect(r.names.get('u1')).toBe('An');
    expect(r.names.get('u2')).toBe('Trần Bình');
    expect(r.warnings).toEqual([]);
  });

  it('lỗi tra tên KHÔNG ném — trả cảnh báo, giữ tên đã có', async () => {
    const c = client(async () => json({ message: 'thiếu quyền' }, 403));
    const r = await resolveParticipantNames(
      c,
      [subtask([{ accountId: 'u1', displayName: 'An' }, { accountId: 'u2' }])],
      FIELDS,
    );

    // u1 vẫn có tên (từ field); u2 không tra được nhưng không làm hỏng đồng bộ.
    expect(r.names.get('u1')).toBe('An');
    expect(r.names.has('u2')).toBe(false);
    expect(r.warnings[0]?.code).toBe('PARTICIPANT_NAMES_UNRESOLVED');
  });
});
