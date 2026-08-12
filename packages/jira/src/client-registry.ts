import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { JiraClient, MAX_CONCURRENT_JIRA_CALLS } from './client.js';
import { StaticCredentialProvider } from './credentials.js';
import type { RateLimiter } from './rate-limiter.js';
import {
  loadStatusIdMap,
  statusMapCacheKey,
  type StatusMapCache,
  type StatusCategoryKey,
} from './status-map.js';
import {
  fieldMappingConfigSchema,
  resolveFieldMapping,
  resolvedFieldMappingSchema,
  type ResolvedFieldMapping,
} from './field-mapping.js';
import { getFields } from './endpoints.js';

/**
 * Registry client Jira THEO DỰ ÁN — hạ tầng cho đa tenant (tenant = project key).
 *
 * Hai bất biến sống còn:
 *
 *   1. Jira giới hạn tốc độ THEO SITE. N dự án cùng trỏ về một site phải CHIA
 *      NHAU đúng một token bucket + một giới hạn song song (C-7: 40 req/s,
 *      song song 8). Mỗi dự án một bucket riêng là lỗi im lặng — test đơn dự án
 *      vẫn xanh, chạy thật với 4 dự án cùng site thì thành 160 req/s và bị Jira
 *      chặn cả tổ chức (rủi ro R-04, mức "Rất cao").
 *
 *   2. Status ID / field ID dạng số ĐỤNG NHAU giữa các site. Mọi cache phải khoá
 *      theo dự án (`meta:statuscategory:<projectKey>`), không dùng khoá toàn cục.
 *
 * Registry này KHÔNG biết gì về DB, Redis hay AES — mọi hạ tầng được tiêm qua
 * `JiraRegistryDeps`. Token đưa vào ĐÃ được tầng gọi giải mã.
 */

/**
 * Kết nối Jira của một dự án — ánh xạ từ hàng trong bảng `project`.
 *
 * Cả ba trường baseUrl/email/apiTokenPlain đều null nghĩa là dự án legacy dùng
 * cấu hình chung từ biến môi trường (`envFallback`).
 */
export interface ProjectJiraConnection {
  readonly projectKey: string;
  /** null → dùng envFallback. */
  readonly baseUrl: string | null;
  readonly email: string | null;
  /** ĐÃ giải mã bởi tầng gọi (AES-256-GCM nằm ngoài package này). */
  readonly apiTokenPlain: string | null;
  /** `jiraFieldsJson` — cùng cấu trúc config/jira-fields.yaml. */
  readonly fieldsConfig: unknown;
  /** `jiraResolvedJson` nếu có — ánh xạ đã resolve từ lần trước. */
  readonly resolvedFields: unknown;
}

/** Cấu hình chung từ env JIRA_* — đường fallback cho dự án legacy. */
export interface JiraEnvFallback {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  /** Nội dung config/jira-fields.yaml đã parse. */
  readonly fieldsConfig: unknown;
}

export interface JiraRegistryDeps {
  /** Đọc kết nối của dự án — một lần đọc hàng DB rẻ, gọi MỖI lần forProject. */
  loadConnection(projectKey: string): Promise<ProjectJiraConnection | null>;
  /** null → không có env JIRA_*; dự án thiếu kết nối riêng sẽ bị chặn rõ ràng. */
  readonly envFallback: JiraEnvFallback | null;
  /**
   * Tạo rate limiter cho MỘT site (khoá theo host). Registry bảo đảm mỗi host
   * chỉ gọi đúng một lần — kết quả dùng chung cho mọi dự án trên site đó.
   * Tầng gọi nên dùng `siteRateLimitKey(baseUrl)` làm khoá Redis.
   */
  createRateLimiter(siteHost: string): RateLimiter;
  /** Cache bảng tra status — cùng interface `loadStatusIdMap` nhận. */
  readonly statusCache: StatusMapCache;
  /** Song song tối đa MỖI SITE — mặc định 8 (C-7). */
  readonly concurrencyPerSite?: number;
  /** Tiêm fetch giả cho test; mặc định fetch toàn cục. */
  readonly fetchImpl?: typeof fetch;
  /** Logger có cấu trúc — truyền xuống JiraClient. */
  readonly logger?: (event: Record<string, unknown>) => void;
}

/** Mọi thứ một job cần để làm việc với Jira của MỘT dự án. */
export interface ProjectJiraContext {
  readonly client: JiraClient;
  readonly fields: ResolvedFieldMapping;
  readonly statusIdMap: Map<string, StatusCategoryKey>;
  readonly connection: ProjectJiraConnection;
}

export interface JiraClientRegistry {
  /**
   * Lấy context của dự án. Kết nối chưa đổi (so bằng fingerprint) → trả context
   * đã cache; đổi hoặc chưa có → dựng lại client + field mapping + status map.
   */
  forProject(projectKey: string): Promise<ProjectJiraContext>;
  /** Xoá cache của dự án — gọi khi admin vừa sửa kết nối và muốn áp dụng ngay. */
  invalidate(projectKey: string): void;
}

export class JiraConnectionError extends Error {
  constructor(
    public readonly projectKey: string,
    detail: string,
  ) {
    super(`Dự án "${projectKey}": ${detail}`);
    this.name = 'JiraConnectionError';
  }
}

/** Kết nối hiệu lực sau khi đã hoà giải giữa hàng DB và env fallback. */
interface EffectiveConnection {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly fieldsConfig: unknown;
  readonly resolvedFields: unknown;
  /** Hàng gốc (hoặc hàng rỗng tổng hợp) — trả nguyên vẹn trong context. */
  readonly connection: ProjectJiraConnection;
}

/** Tài nguyên dùng CHUNG cho mọi dự án trên một site (khoá = host của URL). */
interface SiteEntry {
  readonly rateLimiter: RateLimiter;
  /** fetch đã bọc p-limit của site — trần song song là CỦA SITE, không của dự án. */
  readonly fetchImpl: typeof fetch;
}

export function createJiraRegistry(deps: JiraRegistryDeps): JiraClientRegistry {
  const concurrency = deps.concurrencyPerSite ?? MAX_CONCURRENT_JIRA_CALLS;
  const sites = new Map<string, SiteEntry>();
  const projects = new Map<string, { fingerprint: string; context: Promise<ProjectJiraContext> }>();

  /** Hàng rỗng cho dự án không có bản ghi kết nối — đồng nghĩa "dùng env". */
  const emptyConnection = (projectKey: string): ProjectJiraConnection => ({
    projectKey,
    baseUrl: null,
    email: null,
    apiTokenPlain: null,
    fieldsConfig: null,
    resolvedFields: null,
  });

  function resolveEffective(
    projectKey: string,
    row: ProjectJiraConnection | null,
  ): EffectiveConnection {
    const conn = row ?? emptyConnection(projectKey);
    const provided = [conn.baseUrl, conn.email, conn.apiTokenPlain].filter(
      (v) => v !== null && v.trim() !== '',
    );

    if (provided.length === 3) {
      return {
        baseUrl: conn.baseUrl!,
        email: conn.email!,
        apiToken: conn.apiTokenPlain!,
        fieldsConfig: conn.fieldsConfig,
        resolvedFields: conn.resolvedFields,
        connection: conn,
      };
    }

    if (provided.length > 0) {
      // Nửa vời là cấu hình hỏng, KHÔNG lặng lẽ trộn với env — trộn nửa site này
      // nửa site kia sẽ gọi nhầm site với token của site khác (C-9: thà không
      // chạy còn hơn chạy rồi cho ra số sai).
      throw new JiraConnectionError(
        projectKey,
        'kết nối Jira cấu hình THIẾU — phải có đủ cả ba baseUrl/email/token ' +
          'hoặc để trống cả ba để dùng cấu hình chung từ biến môi trường.',
      );
    }

    if (!deps.envFallback) {
      throw new JiraConnectionError(
        projectKey,
        'chưa cấu hình kết nối Jira riêng và hệ thống cũng không có cấu hình ' +
          'chung JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN. Khai báo kết nối cho ' +
          'dự án hoặc đặt biến môi trường.',
      );
    }

    return {
      baseUrl: deps.envFallback.baseUrl,
      email: deps.envFallback.email,
      apiToken: deps.envFallback.apiToken,
      // Dự án có thể đã khai field mapping riêng dù chưa có credential riêng.
      fieldsConfig: conn.fieldsConfig ?? deps.envFallback.fieldsConfig,
      resolvedFields: conn.resolvedFields,
      connection: conn,
    };
  }

  /**
   * Vân tay của kết nối hiệu lực. Đổi bất kỳ thành phần nào → dựng lại context.
   * Băm cả token nên KHÔNG được ghi giá trị này vào log ở dạng đối chiếu được
   * với danh sách token đoán sẵn — chỉ dùng để so bằng trong RAM.
   */
  function fingerprintOf(eff: EffectiveConnection): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          eff.baseUrl,
          eff.email,
          eff.apiToken,
          eff.fieldsConfig ?? null,
          eff.resolvedFields ?? null,
        ]),
      )
      .digest('hex');
  }

  function hostOf(projectKey: string, baseUrl: string): string {
    try {
      return new URL(baseUrl).host;
    } catch {
      throw new JiraConnectionError(projectKey, `baseUrl Jira không hợp lệ: "${baseUrl}".`);
    }
  }

  function siteFor(host: string): SiteEntry {
    let site = sites.get(host);
    if (!site) {
      // p-limit của SITE bọc quanh fetch: dù mỗi JiraClient có p-limit riêng
      // bên trong, tổng số request đang bay tới một site không bao giờ vượt
      // `concurrency` — kể cả khi 4 dự án cùng site chạy job song song.
      const limit = pLimit(concurrency);
      const baseFetch = deps.fetchImpl ?? fetch;
      site = {
        rateLimiter: deps.createRateLimiter(host),
        fetchImpl: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          limit(() => baseFetch(input, init))) as typeof fetch,
      };
      sites.set(host, site);
    }
    return site;
  }

  async function resolveFields(
    projectKey: string,
    eff: EffectiveConnection,
    client: JiraClient,
  ): Promise<ResolvedFieldMapping> {
    // Có sẵn kết quả resolve hợp lệ thì dùng luôn — tiết kiệm một lần gọi
    // `/field`. JSON trong DB không tin được: sai cấu trúc thì resolve lại,
    // không dùng bừa.
    const pre = resolvedFieldMappingSchema.safeParse(eff.resolvedFields);
    if (pre.success) return pre.data;

    const cfg = fieldMappingConfigSchema.safeParse(eff.fieldsConfig);
    if (!cfg.success) {
      throw new JiraConnectionError(
        projectKey,
        'cấu hình field mapping (jiraFieldsJson) thiếu hoặc sai cấu trúc — cần ' +
          '{ fieldMapping: { wbsStartDate, wbsEndDate } } như config/jira-fields.yaml. ' +
          'Không có ánh xạ này thì toàn bộ Phase mất đường Kế hoạch (PRD E-23).',
      );
    }
    return resolveFieldMapping(cfg.data, await getFields(client));
  }

  async function build(projectKey: string, eff: EffectiveConnection): Promise<ProjectJiraContext> {
    const site = siteFor(hostOf(projectKey, eff.baseUrl));

    const client = new JiraClient({
      credentials: new StaticCredentialProvider({
        baseUrl: eff.baseUrl,
        email: eff.email,
        apiToken: eff.apiToken,
      }),
      rateLimiter: site.rateLimiter,
      concurrency,
      fetchImpl: site.fetchImpl,
      ...(deps.logger ? { logger: deps.logger } : {}),
    });

    const fields = await resolveFields(projectKey, eff, client);
    // Khoá cache THEO DỰ ÁN — status ID số đụng nhau giữa các site.
    const statusIdMap = await loadStatusIdMap(client, deps.statusCache, {
      cacheKey: statusMapCacheKey(projectKey),
    });

    return { client, fields, statusIdMap, connection: eff.connection };
  }

  return {
    async forProject(projectKey: string): Promise<ProjectJiraContext> {
      const row = await deps.loadConnection(projectKey);
      const eff = resolveEffective(projectKey, row);
      const fingerprint = fingerprintOf(eff);

      const cached = projects.get(projectKey);
      if (cached && cached.fingerprint === fingerprint) return cached.context;

      // Lưu promise (không phải kết quả) để hai lời gọi song song cho cùng dự
      // án không dựng hai client. Dựng thất bại thì gỡ khỏi cache để lần sau
      // thử lại thay vì găm lỗi vĩnh viễn.
      const context = build(projectKey, eff).catch((err: unknown) => {
        const current = projects.get(projectKey);
        if (current?.context === context) projects.delete(projectKey);
        throw err;
      });
      projects.set(projectKey, { fingerprint, context });
      return context;
    },

    invalidate(projectKey: string): void {
      projects.delete(projectKey);
    },
  };
}
