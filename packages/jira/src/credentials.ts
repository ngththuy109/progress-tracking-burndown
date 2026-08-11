/**
 * Xác thực với Jira Cloud.
 *
 * Bọc sau interface `CredentialProvider` để sau này chuyển sang OAuth 3LO mà
 * không phải sửa client (PRD §9.3 — "Chuẩn bị cho tương lai").
 */
export interface JiraCredentials {
  readonly baseUrl: string;
  readonly authHeader: string;
}

export interface CredentialProvider {
  get(): Promise<JiraCredentials>;
}

export class MissingCredentialError extends Error {
  constructor(public readonly variable: string) {
    super(
      `Thiếu biến môi trường ${variable}. Hệ thống không khởi động được khi chưa có ` +
        `thông tin xác thực Jira. Xem .env.example.`,
    );
    this.name = 'MissingCredentialError';
  }
}

/**
 * Basic auth bằng API token của tài khoản dịch vụ (PRD §9.3).
 *
 * Thiếu biến môi trường thì CHẶN KHỞI ĐỘNG và báo rõ thiếu biến nào — thà không
 * chạy còn hơn chạy rồi cho ra số sai (CONVENTIONS.md C-9).
 */
export class BasicAuthProvider implements CredentialProvider {
  private cached: JiraCredentials | undefined;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(): Promise<JiraCredentials> {
    if (this.cached) return this.cached;

    const baseUrl = this.require('JIRA_BASE_URL');
    const email = this.require('JIRA_EMAIL');
    const token = this.require('JIRA_API_TOKEN');

    this.cached = {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      authHeader: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
    };
    return this.cached;
  }

  private require(name: string): string {
    const v = this.env[name];
    if (!v || v.trim() === '') throw new MissingCredentialError(name);
    return v.trim();
  }
}

/**
 * Basic auth với thông tin truyền TRỰC TIẾP — dùng cho kết nối theo dự án.
 *
 * Khác `BasicAuthProvider` (đọc env, dùng cho đường fallback legacy), provider
 * này nhận baseUrl/email/token đã được tầng gọi nạp từ bảng `project` và GIẢI MÃ
 * sẵn. Package này không biết gì về AES hay DB — ranh giới ARCHITECTURE.md §2.
 */
export class StaticCredentialProvider implements CredentialProvider {
  private readonly creds: JiraCredentials;

  constructor(opts: { baseUrl: string; email: string; apiToken: string }) {
    this.creds = {
      baseUrl: opts.baseUrl.replace(/\/+$/, ''),
      authHeader: `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`,
    };
  }

  async get(): Promise<JiraCredentials> {
    return this.creds;
  }
}

/**
 * Che thông tin nhạy cảm trước khi ghi log.
 *
 * CONVENTIONS.md C-9 CẤM ghi token vào log. Đây là bộ lọc bắt buộc, không phải
 * tuỳ chọn — token rò rỉ qua log là rủi ro R-09, mức ảnh hưởng "Rất cao".
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /^(authorization|cookie|x-atlassian-token)$/i.test(k) ? '***' : v;
  }
  return out;
}
