/**
 * @app/db — Prisma schema, migration và repository.
 *
 * Ranh giới (ARCHITECTURE.md §2):
 *   - Được import: `@app/shared`
 *   - KHÔNG được import: `@app/engine`, `@app/jira`
 *
 * Đây cũng là nơi duy nhất đổi `snake_case` (DB) sang `camelCase` (API/TS) và
 * đổi `BigInt` sang `number`, theo quy ước C-3. Đừng rải việc đổi kiểu ra khắp nơi.
 */

export const DB_PACKAGE_VERSION = '0.1.0' as const;

export {
  PrismaClient,
  createPrismaClient,
  getPrisma,
  disconnectPrisma,
  toSeconds,
  toDateString,
  fromDateString,
} from './client.js';
export type { Prisma } from './client.js';

export {
  seedWorkCalendars,
  DEFAULT_CALENDARS,
  WORKDAYS_MON_TO_FRI,
} from './seed/work-calendar.seed.js';

export {
  DEFAULT_PHASE_CONFIG,
  SEED_AUTHOR,
  seedDefaultPhaseConfig,
  type SeedDefaultConfigResult,
} from './seed/default-phase-config.js';

export {
  renderDefaultConfigSql,
  SEED_SQL_RELATIVE_PATH,
} from './seed/render-default-config-sql.js';

export {
  findActiveConfigSet,
  saveNewVersion,
  rollbackToVersion,
  listVersions,
  invalidateConfigCache,
  configCacheKey,
  CONFIG_CACHE_PREFIX,
  type ConfigCache,
} from './repositories/phase-config.repository.js';

export {
  assertMigrationsApplied,
  fetchAppliedMigrationNames,
  listMigrationDirNames,
  findPendingMigrations,
  defaultMigrationsDir,
  PendingMigrationsError,
} from './migration-status.js';

export {
  insertIfAbsent,
  findByKey,
  findManyByKeys,
  listActiveEpics,
  listVisibleActiveEpics,
  updateEpic,
  removeEpic,
  listWithHealth,
  listMissingDates,
  type UpsertTrackedEpicArgs,
  type UpdateEpicData,
  type VisibleEpicRow,
} from './repositories/tracked-epic.repository.js';

export {
  listExemptionsForEpics,
  upsertExemption,
  deleteExemption,
  type LogworkExemptionRecord,
  type UpsertLogworkExemptionArgs,
} from './repositories/logwork-exemption.repository.js';

export {
  findAppUser,
  listAppUsers,
  deleteAppUser,
  upsertAppUser,
  type AppUserRow,
  type UpsertAppUserArgs,
} from './repositories/app-user.repository.js';

export {
  listProjects,
  projectKeySet,
  upsertProject,
  deleteProject,
  type ProjectRow,
} from './repositories/project.repository.js';

export {
  upsertIssues,
  markRemovedIssues,
  knownIdToKey,
  type IssueUpsertRow,
} from './repositories/issue.repository.js';

export {
  upsertWorklogs,
  markWorklogsDeleted,
  markWorklogsDeletedMissing,
  type WorklogUpsertRow,
} from './repositories/worklog.repository.js';

export { upsertChangelog, type ChangelogUpsertRow } from './repositories/changelog.repository.js';

export {
  startSyncRun,
  finishSyncRun,
  failStaleSyncRuns,
  STALE_RUN_ERROR_MESSAGE,
} from './repositories/sync-run.repository.js';

export {
  getCalendar,
  CalendarCache,
  FALLBACK_TIMEZONE,
} from './repositories/calendar.repository.js';

export {
  listCalendarsWithHolidayMeta,
  calendarExists,
  listHolidays,
  importHolidays,
  deleteHoliday,
  epicKeysUsingCalendar,
  type CalendarWithHolidayMeta,
  type ImportHolidaysResult,
} from './repositories/calendar-holiday.repository.js';

export {
  listMakeupWorkdays,
  importMakeupWorkdays,
  deleteMakeupWorkday,
  type ImportMakeupWorkdaysResult,
} from './repositories/calendar-makeup-workday.repository.js';

export {
  upsertPhaseRollups,
  loadPhaseRollups,
  deleteObsoleteRollups,
} from './repositories/phase-rollup.repository.js';

export {
  loadSnapshotsForChart,
  latestSnapshotDate,
  loadDataQualityRatios,
} from './repositories/snapshot-read.repository.js';

export {
  loadExplainBundle,
  storedRemainingSeconds,
  loadHealthRatios,
  type ExplainBundle,
} from './repositories/explain.repository.js';

export {
  upsertSubtaskActualDates,
  type SubtaskActualDatesRow,
} from './repositories/subtask-actual-dates.repository.js';

export {
  insertPlanShifts,
  summarizePlanShifts,
  listPlanShifts,
  type InsertShiftResult,
  type PlanShiftSummary,
} from './repositories/plan-shift.repository.js';

export {
  upsertSnapshots,
  listSnapshotDates,
  previousTotalScope,
  loadSnapshots,
  type UpsertSnapshotResult,
} from './repositories/snapshot.repository.js';

export {
  findLdapConfig,
  upsertLdapConfig,
  type LdapConfigRow,
  type UpsertLdapConfigArgs,
} from './repositories/auth-ldap.repository.js';

export {
  seal,
  open,
  parseEncryptionKey,
  SecretBoxError,
  SECRET_BOX_VERSION,
  SECRET_KEY_BYTES,
} from './crypto/secret-box.js';
