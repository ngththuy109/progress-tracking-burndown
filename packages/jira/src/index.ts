/**
 * @app/jira — client gọi Jira Cloud REST API v3.
 *
 * Ranh giới (ARCHITECTURE.md §2):
 *   - Được import: `@app/shared`
 *   - KHÔNG được import: `@app/engine`, `@app/db`
 *
 * Package này CHỈ ĐỌC từ Jira. Không có endpoint ghi nào — hệ thống không bao
 * giờ sửa dữ liệu trên Jira (PRD §1.4).
 *
 * Giới hạn tốc độ bắt buộc (C-7): 40 request/giây toàn hệ thống qua token bucket,
 * song song tối đa 8. Rủi ro R-04 xếp mức ảnh hưởng "Rất cao" — bị Jira chặn sẽ
 * ảnh hưởng cả tổ chức, không riêng hệ thống này.
 */

export const JIRA_PACKAGE_VERSION = '0.1.0' as const;

export {
  BasicAuthProvider,
  StaticCredentialProvider,
  MissingCredentialError,
  redactHeaders,
  type CredentialProvider,
  type JiraCredentials,
} from './credentials.js';

export {
  TokenBucketRateLimiter,
  InMemoryTokenBucketStore,
  REDIS_TOKEN_BUCKET_LUA,
  DEFAULT_RATE_LIMIT_PER_SEC,
  siteRateLimitKey,
  type RateLimiter,
  type TokenBucketStore,
} from './rate-limiter.js';

export {
  withRetry,
  isRetryable,
  parseRetryAfter,
  backoffDelayMs,
  JiraHttpError,
  MAX_RETRIES,
  BASE_DELAY_MS,
  MAX_JITTER_MS,
  type RetryOptions,
} from './retry.js';

export { JiraClient, MAX_CONCURRENT_JIRA_CALLS, type JiraClientOptions } from './client.js';

export * from './endpoints.js';

export {
  loadStatusIdMap,
  statusMapCacheKey,
  STATUS_MAP_CACHE_KEY,
  STATUS_MAP_TTL_SECONDS,
  type StatusMapCache,
  type StatusMapLoadOptions,
  type StatusCategoryKey,
} from './status-map.js';

export {
  resolveFieldMapping,
  readWbsDates,
  toDateOnly,
  fieldIdsForSearch,
  fieldMappingConfigSchema,
  resolvedFieldMappingSchema,
  FieldMappingError,
  type FieldMappingConfig,
  type ResolvedFieldMapping,
} from './field-mapping.js';

export {
  createJiraRegistry,
  JiraConnectionError,
  type ProjectJiraConnection,
  type JiraEnvFallback,
  type JiraRegistryDeps,
  type ProjectJiraContext,
  type JiraClientRegistry,
} from './client-registry.js';
