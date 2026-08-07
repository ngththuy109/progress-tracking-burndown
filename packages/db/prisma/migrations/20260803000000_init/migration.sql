-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";
-- CreateTable
CREATE TABLE "jira_issue" (
    "issue_key" VARCHAR(32) NOT NULL,
    "issue_id" BIGINT NOT NULL,
    "issue_type" VARCHAR(16) NOT NULL,
    "parent_key" VARCHAR(32),
    "epic_key" VARCHAR(32),
    "summary" TEXT NOT NULL,
    "phase_code" VARCHAR(24),
    "raw_phase_label" TEXT,
    "status_id" VARCHAR(16) NOT NULL,
    "status_category" VARCHAR(16) NOT NULL,
    "original_estimate_s" BIGINT NOT NULL DEFAULT 0,
    "remaining_estimate_s" BIGINT NOT NULL DEFAULT 0,
    "time_spent_s" BIGINT NOT NULL DEFAULT 0,
    "jira_created_at" TIMESTAMPTZ(6) NOT NULL,
    "jira_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "removed_at" TIMESTAMPTZ(6),
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sb_project" VARCHAR(64),
    "sb_team" VARCHAR(64),
    "sb_phase_raw" VARCHAR(64),
    "function_name" VARCHAR(128),
    "function_key" VARCHAR(128),
    "task_type" VARCHAR(32),
    "sb_parse_status" VARCHAR(24) NOT NULL DEFAULT 'UNPARSED',
    CONSTRAINT "jira_issue_pkey" PRIMARY KEY ("issue_key")
);
-- CreateTable
CREATE TABLE "issue_changelog_event" (
    "id" BIGSERIAL NOT NULL,
    "issue_key" VARCHAR(32) NOT NULL,
    "jira_history_id" BIGINT NOT NULL,
    "field_name" VARCHAR(48) NOT NULL,
    "from_value" TEXT,
    "to_value" TEXT,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "author_id" VARCHAR(64),
    CONSTRAINT "issue_changelog_event_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "worklog_entry" (
    "worklog_id" BIGINT NOT NULL,
    "issue_key" VARCHAR(32) NOT NULL,
    "epic_key" VARCHAR(32) NOT NULL,
    "author_id" VARCHAR(64),
    "time_spent_s" BIGINT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "worklog_entry_pkey" PRIMARY KEY ("worklog_id")
);
-- CreateTable
CREATE TABLE "tracked_epic" (
    "epic_key" VARCHAR(32) NOT NULL,
    "epic_id" BIGINT NOT NULL,
    "project_key" VARCHAR(32) NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "timezone" VARCHAR(48) NOT NULL,
    "calendar_id" VARCHAR(32) NOT NULL,
    "added_by" VARCHAR(64) NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "note" TEXT,
    CONSTRAINT "tracked_epic_pkey" PRIMARY KEY ("epic_key")
);
-- CreateTable
CREATE TABLE "daily_snapshot" (
    "id" BIGSERIAL NOT NULL,
    "epic_key" VARCHAR(32) NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "snapshot_at_utc" TIMESTAMPTZ(6) NOT NULL,
    "planned_remaining_s" BIGINT NOT NULL,
    "actual_remaining_s" BIGINT NOT NULL,
    "total_scope_s" BIGINT NOT NULL,
    "total_spent_s" BIGINT NOT NULL,
    "scope_added_s" BIGINT NOT NULL DEFAULT 0,
    "scope_removed_s" BIGINT NOT NULL DEFAULT 0,
    "count_todo" INTEGER NOT NULL DEFAULT 0,
    "count_in_progress" INTEGER NOT NULL DEFAULT 0,
    "count_done" INTEGER NOT NULL DEFAULT 0,
    "per_phase" JSONB NOT NULL,
    "is_recomputed" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_read_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "daily_snapshot_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "sync_run" (
    "id" BIGSERIAL NOT NULL,
    "epic_key" VARCHAR(32) NOT NULL,
    "run_type" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "watermark_before" TIMESTAMPTZ(6),
    "watermark_after" TIMESTAMPTZ(6),
    "days_computed" INTEGER NOT NULL DEFAULT 0,
    "api_calls_made" INTEGER NOT NULL DEFAULT 0,
    "rate_limit_hits" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    CONSTRAINT "sync_run_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "phase_config_set" (
    "id" BIGSERIAL NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "project_key" VARCHAR(32),
    "version" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "fallback_scan_full_title" BOOLEAN NOT NULL DEFAULT true,
    "created_by" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    CONSTRAINT "phase_config_set_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "phase_title_pattern" (
    "id" BIGSERIAL NOT NULL,
    "config_set_id" BIGINT NOT NULL,
    "pattern_text" TEXT NOT NULL,
    "compiled_regex" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    CONSTRAINT "phase_title_pattern_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "phase_definition" (
    "id" BIGSERIAL NOT NULL,
    "config_set_id" BIGINT NOT NULL,
    "phase_code" VARCHAR(24) NOT NULL,
    "label_vi" TEXT NOT NULL,
    "label_ja" TEXT,
    "color_hex" CHAR(7),
    "display_order" INTEGER NOT NULL,
    CONSTRAINT "phase_definition_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "phase_match_rule" (
    "id" BIGSERIAL NOT NULL,
    "config_set_id" BIGINT NOT NULL,
    "keyword" TEXT NOT NULL,
    "match_mode" VARCHAR(16) NOT NULL DEFAULT 'CONTAINS',
    "phase_code" VARCHAR(24) NOT NULL,
    "match_priority" INTEGER NOT NULL DEFAULT 50,
    CONSTRAINT "phase_match_rule_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "subtask_title_pattern" (
    "id" BIGSERIAL NOT NULL,
    "config_set_id" BIGINT NOT NULL,
    "pattern_text" TEXT NOT NULL,
    "compiled_regex" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    CONSTRAINT "subtask_title_pattern_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "signboard_column" (
    "id" BIGSERIAL NOT NULL,
    "config_set_id" BIGINT NOT NULL,
    "task_code" VARCHAR(32) NOT NULL,
    "label_vi" TEXT NOT NULL,
    "label_ja" TEXT,
    "display_order" INTEGER NOT NULL,
    CONSTRAINT "signboard_column_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "work_calendar" (
    "calendar_id" VARCHAR(32) NOT NULL,
    "timezone" VARCHAR(48) NOT NULL,
    "workdays_mask" SMALLINT NOT NULL,
    "hours_per_day" DECIMAL(4,2) NOT NULL DEFAULT 8.0,
    CONSTRAINT "work_calendar_pkey" PRIMARY KEY ("calendar_id")
);
-- CreateTable
CREATE TABLE "calendar_holiday" (
    "calendar_id" VARCHAR(32) NOT NULL,
    "holiday_date" DATE NOT NULL,
    "label" TEXT,
    CONSTRAINT "calendar_holiday_pkey" PRIMARY KEY ("calendar_id","holiday_date")
);
-- CreateTable
CREATE TABLE "phase_rollup" (
    "epic_key" VARCHAR(32) NOT NULL,
    "phase_code" VARCHAR(24) NOT NULL,
    "plan_start" DATE,
    "plan_end" DATE,
    "plan_workdays" INTEGER,
    "actual_start" DATE,
    "actual_end" DATE,
    "actual_end_is_provisional" BOOLEAN NOT NULL DEFAULT false,
    "total_original_s" BIGINT NOT NULL DEFAULT 0,
    "subtask_count" INTEGER NOT NULL DEFAULT 0,
    "missing_date_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "phase_rollup_pkey" PRIMARY KEY ("epic_key","phase_code")
);
-- CreateTable
CREATE TABLE "plan_shift_history" (
    "id" BIGSERIAL NOT NULL,
    "epic_key" VARCHAR(32) NOT NULL,
    "phase_code" VARCHAR(24) NOT NULL,
    "shift_type" VARCHAR(16) NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "shifted_workdays" INTEGER NOT NULL,
    "caused_by_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plan_shift_history_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "jira_issue_issue_id_key" ON "jira_issue"("issue_id");
-- CreateIndex
CREATE INDEX "idx_issue_epic" ON "jira_issue"("epic_key", "issue_type");
-- CreateIndex
CREATE INDEX "idx_issue_parent" ON "jira_issue"("parent_key");
-- CreateIndex
CREATE INDEX "idx_issue_updated" ON "jira_issue"("jira_updated_at" DESC);
-- CreateIndex
CREATE INDEX "idx_changelog_lookup" ON "issue_changelog_event"("issue_key", "field_name", "changed_at" DESC);
-- CreateIndex
CREATE UNIQUE INDEX "uq_changelog" ON "issue_changelog_event"("issue_key", "jira_history_id", "field_name");
-- CreateIndex
CREATE INDEX "idx_worklog_issue_started" ON "worklog_entry"("issue_key", "started_at");
-- CreateIndex
CREATE INDEX "idx_worklog_epic_started" ON "worklog_entry"("epic_key", "started_at");
-- CreateIndex
CREATE UNIQUE INDEX "tracked_epic_epic_id_key" ON "tracked_epic"("epic_id");
-- CreateIndex
CREATE INDEX "idx_tracked_project" ON "tracked_epic"("project_key");
-- CreateIndex
CREATE INDEX "idx_snapshot_chart" ON "daily_snapshot"("epic_key", "snapshot_date" ASC);
-- CreateIndex
CREATE UNIQUE INDEX "uq_snapshot" ON "daily_snapshot"("epic_key", "snapshot_date");
-- CreateIndex
CREATE INDEX "idx_syncrun_recent" ON "sync_run"("epic_key", "started_at" DESC);
-- CreateIndex
CREATE UNIQUE INDEX "uq_config_version" ON "phase_config_set"("scope", "project_key", "version");
-- CreateIndex
CREATE INDEX "idx_pattern_set" ON "phase_title_pattern"("config_set_id", "sort_order");
-- CreateIndex
CREATE UNIQUE INDEX "uq_phase_code" ON "phase_definition"("config_set_id", "phase_code");
-- CreateIndex
CREATE INDEX "idx_rule_set" ON "phase_match_rule"("config_set_id", "match_priority");
-- CreateIndex
CREATE INDEX "idx_subtask_pattern_set" ON "subtask_title_pattern"("config_set_id", "sort_order");
-- CreateIndex
CREATE INDEX "idx_sbcolumn_set" ON "signboard_column"("config_set_id", "display_order");
-- CreateIndex
CREATE UNIQUE INDEX "uq_task_code" ON "signboard_column"("config_set_id", "task_code");
-- CreateIndex
CREATE INDEX "idx_planshift_epic" ON "plan_shift_history"("epic_key", "detected_at" DESC);
-- AddForeignKey
ALTER TABLE "jira_issue" ADD CONSTRAINT "jira_issue_parent_key_fkey" FOREIGN KEY ("parent_key") REFERENCES "jira_issue"("issue_key") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "tracked_epic" ADD CONSTRAINT "tracked_epic_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "work_calendar"("calendar_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "phase_title_pattern" ADD CONSTRAINT "phase_title_pattern_config_set_id_fkey" FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "phase_definition" ADD CONSTRAINT "phase_definition_config_set_id_fkey" FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "phase_match_rule" ADD CONSTRAINT "phase_match_rule_config_set_id_fkey" FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "subtask_title_pattern" ADD CONSTRAINT "subtask_title_pattern_config_set_id_fkey" FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "signboard_column" ADD CONSTRAINT "signboard_column_config_set_id_fkey" FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "calendar_holiday" ADD CONSTRAINT "calendar_holiday_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "work_calendar"("calendar_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "phase_rollup" ADD CONSTRAINT "phase_rollup_epic_key_fkey" FOREIGN KEY ("epic_key") REFERENCES "tracked_epic"("epic_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- PHẦN DƯỚI ĐÂY PRISMA KHÔNG SINH ĐƯỢC — phải viết SQL thô.
-- Thiếu chúng thì schema vẫn tạo được nhưng MẤT các lớp bảo vệ dữ liệu.
-- Xem PRD §4.6 và card T-02.
-- ============================================================================

-- ---- CHECK constraint --------------------------------------------------------

-- Vòng đời Epic chỉ có đúng 5 trạng thái (PRD §2.6.1)
ALTER TABLE "tracked_epic"
  ADD CONSTRAINT "ck_epic_status"
  CHECK (status IN ('PENDING','BACKFILLING','ACTIVE','PAUSED','ERROR'));

-- scope = GLOBAL thì project_key phải NULL, và ngược lại
ALTER TABLE "phase_config_set"
  ADD CONSTRAINT "ck_config_scope"
  CHECK (
    (scope = 'GLOBAL'  AND project_key IS NULL) OR
    (scope = 'PROJECT' AND project_key IS NOT NULL)
  );

ALTER TABLE "phase_match_rule"
  ADD CONSTRAINT "ck_match_mode"
  CHECK (match_mode IN ('CONTAINS','REGEX'));

ALTER TABLE "plan_shift_history"
  ADD CONSTRAINT "ck_shift_type"
  CHECK (shift_type IN ('START_MOVED','END_MOVED'));

-- ---- Partial index ------------------------------------------------------------

-- Mỗi phạm vi chỉ có ĐÚNG MỘT bộ cấu hình đang hiệu lực.
-- Không có hai index này thì có thể tồn tại 2 bộ cùng is_active và
-- getEffectiveConfig() sẽ trả kết quả ngẫu nhiên.
CREATE UNIQUE INDEX "idx_config_active_global"
  ON "phase_config_set" (scope)
  WHERE is_active AND scope = 'GLOBAL';

CREATE UNIQUE INDEX "idx_config_active_project"
  ON "phase_config_set" (project_key)
  WHERE is_active AND scope = 'PROJECT';

-- Job đêm quét đúng index này (PRD §2.6.1)
CREATE INDEX "idx_tracked_active"
  ON "tracked_epic" (status)
  WHERE status = 'ACTIVE';

-- Truy vấn dựng bảng Signboard (PRD §6) — API tính lúc đọc nên index này
-- là thứ giữ cho p95 dưới 500ms
CREATE INDEX "idx_issue_signboard"
  ON "jira_issue" (epic_key, phase_code, function_key, task_type)
  WHERE issue_type = 'SUBTASK' AND removed_at IS NULL;

-- Tìm nhanh Sub-task chưa lên được bảng (PRD §6.8)
CREATE INDEX "idx_issue_unparsed"
  ON "jira_issue" (epic_key, sb_parse_status)
  WHERE sb_parse_status <> 'OK';

-- Phát hiện log giờ lùi ngày: started_at cách created_at quá xa
-- nghĩa là cần tính lại quá khứ (PRD E-03)
--
-- Vị ngữ PHẢI viết dạng (created_at - started_at) > INTERVAL '1 day', KHÔNG
-- được viết started_at < created_at - INTERVAL '1 day'. Lý do: phép TIMESTAMPTZ
-- trừ INTERVAL (timestamptz_mi_interval) chỉ là STABLE — cộng/trừ 'ngày' vào
-- timestamptz phụ thuộc múi giờ (DST) — trong khi index predicate bắt buộc chỉ
-- gọi hàm IMMUTABLE, nếu không PostgreSQL báo lỗi 42P17
-- ("functions in index predicate must be marked IMMUTABLE"). Ngược lại,
-- TIMESTAMPTZ trừ TIMESTAMPTZ (timestamptz_mi) là IMMUTABLE nên hợp lệ. Dạng
-- này cũng khớp đúng ngưỡng 24h của hasRetroLog() bên apps/worker
-- (RETRO_LOG_THRESHOLD_MS), nên SQL và code đọc cùng một định nghĩa.
CREATE INDEX "idx_worklog_retro"
  ON "worklog_entry" (epic_key, created_at)
  WHERE created_at - started_at > INTERVAL '1 day';
