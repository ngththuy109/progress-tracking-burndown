import {
  JiraClient,
  JiraHttpError,
  StaticCredentialProvider,
  fieldMappingConfigSchema,
  getFields,
  resolveFieldMapping,
  FieldMappingError,
} from '@app/jira';
import type { JiraTestResponse } from '@app/shared';
import type { JiraConnectionTester } from '../routes/projects.routes.js';

/**
 * "Test connection" của một tenant — POST /api/admin/projects/:key/jira/test.
 *
 * Dựng JiraClient THEO YÊU CẦU với đúng thông tin đưa vào (đã hoà giải
 * body → DB → env ở tầng route), chạy ba bước và DỪNG Ở BƯỚC HỎNG ĐẦU TIÊN:
 *
 *   1. AUTH           — GET /rest/api/3/myself: URL/email/token có đúng không.
 *   2. FIELDS         — GET /field + resolve field mapping wbs_start/end (E-23).
 *   3. PROJECT_ACCESS — đếm issue bằng JQL `project = KEY`: tài khoản có thấy
 *                       project này không (đúng site, đúng quyền browse).
 *
 * Đây là nơi DUY NHẤT (ngoài registry per-project và điểm lắp ráp) của apps/api
 * được import @app/jira. Không dùng client/rate-limiter dùng chung: mỗi lần test
 * chỉ là 3 request tương tác do admin bấm tay.
 */

type Step = JiraTestResponse['steps'][number];
type StepName = Step['step'];

const okStep = (step: StepName, detail: string): Step => ({ step, ok: true, detail });
const failStep = (step: StepName, detail: string): Step => ({ step, ok: false, detail });

/** Đổi lỗi gọi Jira thành một câu chẩn đoán được — không lộ token. */
function describeError(err: unknown): string {
  if (err instanceof JiraHttpError) {
    if (err.status === 401) return 'HTTP 401 — email hoặc API token sai.';
    if (err.status === 403) return 'HTTP 403 — tài khoản không có quyền truy cập.';
    if (err.status === 404) return 'HTTP 404 — URL Jira sai hoặc site không tồn tại.';
    return `HTTP ${err.status} từ Jira.`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Phản hồi của GET /rest/api/3/myself — chỉ cần vài trường để hiển thị. */
interface MyselfResponse {
  readonly displayName?: string;
  readonly emailAddress?: string;
}

interface ApproximateCountResponse {
  readonly count?: number;
}

export interface JiraTesterOptions {
  /** Tiêm fetch giả cho test đơn vị; mặc định fetch toàn cục. */
  readonly fetchImpl?: typeof fetch;
  readonly logger?: (event: Record<string, unknown>) => void;
}

export function createJiraConnectionTester(options: JiraTesterOptions = {}): JiraConnectionTester {
  return {
    async test({ baseUrl, email, apiToken, fieldsConfig, projectKey }) {
      const steps: Step[] = [];
      const done = (): JiraTestResponse => ({ ok: steps.every((s) => s.ok), steps });

      // Thiếu thông tin kết nối là kết quả CHẨN ĐOÁN, không phải lỗi 500: admin
      // cần biết chính xác thiếu gì (chưa khai riêng và env JIRA_* cũng trống).
      const missing = [
        ...(baseUrl === null || baseUrl.trim() === '' ? ['jiraBaseUrl'] : []),
        ...(email === null || email.trim() === '' ? ['jiraEmail'] : []),
        ...(apiToken === null || apiToken.trim() === '' ? ['apiToken'] : []),
      ];
      if (missing.length > 0) {
        steps.push(
          failStep(
            'AUTH',
            `Thiếu thông tin kết nối: ${missing.join(', ')}. ` +
              'Khai kết nối riêng cho dự án hoặc đặt env JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN.',
          ),
        );
        return done();
      }

      const client = new JiraClient({
        credentials: new StaticCredentialProvider({
          baseUrl: baseUrl!,
          email: email!,
          apiToken: apiToken!,
        }),
        // Test là thao tác admin bấm tay, 3 request — không cần retry dài; để
        // maxRetries mặc định cũng vô hại nhưng làm admin chờ lâu khi URL sai.
        retry: { maxRetries: 0 },
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      });

      // ---- 1. AUTH ---------------------------------------------------------
      try {
        const me = await client.request<MyselfResponse>('/rest/api/3/myself');
        const who = me.displayName ?? me.emailAddress ?? email;
        steps.push(okStep('AUTH', `Đăng nhập thành công (tài khoản: ${who}).`));
      } catch (err) {
        steps.push(failStep('AUTH', `Không đăng nhập được Jira: ${describeError(err)}`));
        return done();
      }

      // ---- 2. FIELDS -------------------------------------------------------
      const cfg = fieldMappingConfigSchema.safeParse(fieldsConfig);
      if (!cfg.success) {
        steps.push(
          failStep(
            'FIELDS',
            'Cấu hình field mapping thiếu hoặc sai cấu trúc — cần ' +
              '{ fieldMapping: { wbsStartDate, wbsEndDate } } như config/jira-fields.yaml.',
          ),
        );
        return done();
      }
      try {
        const resolved = resolveFieldMapping(cfg.data, await getFields(client));
        steps.push(
          okStep(
            'FIELDS',
            `Field mapping hợp lệ: wbs_start_date=${resolved.wbsStartDate}, wbs_end_date=${resolved.wbsEndDate}.`,
          ),
        );
      } catch (err) {
        const detail =
          err instanceof FieldMappingError ? err.message : describeError(err);
        steps.push(failStep('FIELDS', `Field mapping không hợp lệ: ${detail}`));
        return done();
      }

      // ---- 3. PROJECT_ACCESS ----------------------------------------------
      try {
        const res = await client.request<ApproximateCountResponse>(
          '/rest/api/3/search/approximate-count',
          { method: 'POST', body: { jql: `project = "${projectKey.replace(/"/g, '\\"')}"` } },
        );
        const count = typeof res.count === 'number' ? res.count : 0;
        // JQL với project không tồn tại/không thấy được trả HTTP 400 — rơi vào
        // nhánh catch. Đếm được (kể cả 0 issue) nghĩa là NHÌN THẤY project.
        steps.push(
          okStep('PROJECT_ACCESS', `Đọc được project ${projectKey} (~${count} issue).`),
        );
      } catch (err) {
        const hint =
          err instanceof JiraHttpError && err.status === 400
            ? `Jira không nhìn thấy project "${projectKey}" bằng tài khoản này — sai site hoặc thiếu quyền Browse.`
            : describeError(err);
        steps.push(failStep('PROJECT_ACCESS', `Không đọc được project ${projectKey}: ${hint}`));
      }

      return done();
    },
  };
}
