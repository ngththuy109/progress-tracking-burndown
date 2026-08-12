-- Multi-tenant: nhiều dự án dùng chung 1 DB, mỗi dự án tự chứa kết nối Jira,
-- cấu trúc phân tầng và thành viên riêng (plan multi-tenant, 2026-08).
--
-- TENANT = JIRA PROJECT KEY. Issue key Jira luôn có dạng `<KEY>-<n>` nên khi
-- project key duy nhất toàn hệ thống thì issue_key không bao giờ trùng giữa các
-- tenant, kể cả hai tenant nằm trên hai Jira site khác nhau → `jira_issue` GIỮ
-- NGUYÊN PK issue_key, không phải đổi khóa dây chuyền. Ngược lại, các ID SỐ của
-- Jira (issue_id, worklog_id, epic_id) chỉ duy nhất TRONG MỘT SITE → mọi ràng
-- buộc unique theo số phải nới thành per-project hoặc bỏ.
--
-- BACKFILL: dữ liệu single-tenant hiện có được gán tenant qua join
-- `epic_key → tracked_epic` (row Epic tự tham chiếu epic_key của chính nó nên
-- join phủ 100% số dòng còn sổ đăng ký); dòng mồ côi (epic đã bị gỡ) rơi về
-- prefix của issue_key. Sau migration hệ thống chạy y như cũ: project chưa nhập
-- kết nối riêng (các cột NULL) dùng env JIRA_*, quyền PM/VIEWER cũ được chuyển
-- thành membership per-project, VIEWER cũ được cấp quyền xem MỌI project hiện
-- có để không ai mất quyền trong im lặng.

-- ============================================================================
-- 1) project: picklist → gốc tenant
-- ============================================================================
ALTER TABLE "project"
  ADD COLUMN "status"              VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "jira_base_url"       TEXT,
  ADD COLUMN "jira_email"          VARCHAR(254),
  ADD COLUMN "jira_token_enc"      TEXT,
  ADD COLUMN "jira_fields_json"    JSONB,
  ADD COLUMN "jira_resolved_json"  JSONB,
  ADD COLUMN "hierarchy_depth"     SMALLINT NOT NULL DEFAULT 2,
  ADD COLUMN "timezone"            VARCHAR(48) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  ADD COLUMN "default_calendar_id" VARCHAR(32);

ALTER TABLE "project"
  ADD CONSTRAINT "project_status_check" CHECK ("status" IN ('ACTIVE', 'ARCHIVED'));

-- 1..4 tầng dưới root. Sync đọc giá trị này để biết dừng đào cây ở đâu; số
-- ngoài khoảng là cấu hình hỏng → chặn ngay tại DB.
ALTER TABLE "project"
  ADD CONSTRAINT "project_hierarchy_depth_check"
  CHECK ("hierarchy_depth" BETWEEN 1 AND 4);

-- ============================================================================
-- 2) Tạo tenant từ dữ liệu hiện có (mọi project từng có epic được theo dõi)
-- ============================================================================
INSERT INTO "project" ("project_key")
SELECT DISTINCT "project_key" FROM "tracked_epic"
ON CONFLICT ("project_key") DO NOTHING;

-- ============================================================================
-- 3) project_member: role riêng theo từng dự án + chuyển quyền cũ
-- ============================================================================
CREATE TABLE "project_member" (
  "project_key" VARCHAR(32)  NOT NULL,
  "user_id"     VARCHAR(254) NOT NULL,
  "role"        VARCHAR(16)  NOT NULL,
  "added_by"    VARCHAR(254) NOT NULL,
  "added_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "project_member_pkey" PRIMARY KEY ("project_key", "user_id"),
  CONSTRAINT "project_member_project_key_fkey" FOREIGN KEY ("project_key")
    REFERENCES "project" ("project_key") ON DELETE CASCADE,
  CONSTRAINT "project_member_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "app_user" ("user_id") ON DELETE CASCADE,
  CONSTRAINT "project_member_role_check" CHECK ("role" IN ('PM', 'VIEWER'))
);

CREATE INDEX "idx_member_user" ON "project_member" ("user_id");

-- PM cũ: mỗi key trong mảng `projects` → 1 dòng membership PM.
-- Join với `project` để bỏ key gõ nhầm không trỏ tới project nào có thật.
INSERT INTO "project_member" ("project_key", "user_id", "role", "added_by")
SELECT p."project_key", u."user_id", 'PM', 'migration:20260812000000'
FROM "app_user" u
CROSS JOIN LATERAL unnest(u."projects") AS pk("project_key")
JOIN "project" p ON p."project_key" = pk."project_key"
WHERE u."role" = 'PM'
ON CONFLICT DO NOTHING;

-- VIEWER cũ vốn thấy TẤT CẢ → cấp membership VIEWER trên mọi project hiện có,
-- để sau nâng cấp không ai bị trắng màn hình. Project TẠO MỚI về sau thì phải
-- được cấp quyền thủ công — đó là hành vi multi-tenant mong muốn.
INSERT INTO "project_member" ("project_key", "user_id", "role", "added_by")
SELECT p."project_key", u."user_id", 'VIEWER', 'migration:20260812000000'
FROM "app_user" u
CROSS JOIN "project" p
WHERE u."role" = 'VIEWER'
ON CONFLICT DO NOTHING;

-- Role toàn cục rút còn ADMIN | MEMBER; PM/VIEWER giờ là role per-project.
UPDATE "app_user" SET "role" = 'MEMBER' WHERE "role" IN ('PM', 'VIEWER');

ALTER TABLE "app_user" DROP CONSTRAINT "app_user_role_check";
ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_role_check" CHECK ("role" IN ('ADMIN', 'MEMBER'));

ALTER TABLE "app_user" DROP COLUMN "projects";

-- ============================================================================
-- 4) jira_issue: cột tenant + tầng; nới unique ID số thành per-project
-- ============================================================================
ALTER TABLE "jira_issue"
  ADD COLUMN "project_key" VARCHAR(32),
  ADD COLUMN "tier_index"  SMALLINT NOT NULL DEFAULT 2;

-- Gán tenant qua sổ đăng ký (row Epic tự tham chiếu epic_key nên phủ 100%
-- số issue còn epic trong sổ)...
UPDATE "jira_issue" i
SET "project_key" = t."project_key"
FROM "tracked_epic" t
WHERE i."epic_key" = t."epic_key" AND i."project_key" IS NULL;

-- ...dòng mồ côi (epic đã bị gỡ khỏi sổ) rơi về prefix của issue_key —
-- đúng với dữ liệu single-tenant vì tất cả đến từ một site.
UPDATE "jira_issue"
SET "project_key" = split_part("issue_key", '-', 1)
WHERE "project_key" IS NULL;

-- Prefix mồ côi có thể chưa có trong danh mục project → tạo cho đủ trước khi FK.
INSERT INTO "project" ("project_key")
SELECT DISTINCT "project_key" FROM "jira_issue"
ON CONFLICT ("project_key") DO NOTHING;

ALTER TABLE "jira_issue" ALTER COLUMN "project_key" SET NOT NULL;

ALTER TABLE "jira_issue"
  ADD CONSTRAINT "jira_issue_project_key_fkey" FOREIGN KEY ("project_key")
    REFERENCES "project" ("project_key") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- EPIC=0, TASK=1, SUBTASK=2 — đúng cấu trúc 3 tầng cũ (depth 2 dưới root).
UPDATE "jira_issue"
SET "tier_index" = CASE "issue_type" WHEN 'EPIC' THEN 0 WHEN 'TASK' THEN 1 ELSE 2 END;

-- ID số chỉ duy nhất trong một site → unique theo (project, id).
-- (Ở migration init đây là UNIQUE INDEX, không phải constraint → DROP INDEX.)
DROP INDEX "jira_issue_issue_id_key";
CREATE UNIQUE INDEX "uq_issue_project_id" ON "jira_issue" ("project_key", "issue_id");

CREATE INDEX "idx_issue_project_type" ON "jira_issue" ("project_key", "issue_type");

-- ============================================================================
-- 5) worklog_entry: PK → (project_key, worklog_id)
--    Không bảng nào FK tới worklog_entry nên đổi PK không dây chuyền.
-- ============================================================================
ALTER TABLE "worklog_entry" ADD COLUMN "project_key" VARCHAR(32);

UPDATE "worklog_entry" w
SET "project_key" = t."project_key"
FROM "tracked_epic" t
WHERE w."epic_key" = t."epic_key" AND w."project_key" IS NULL;

UPDATE "worklog_entry"
SET "project_key" = split_part("epic_key", '-', 1)
WHERE "project_key" IS NULL;

ALTER TABLE "worklog_entry" ALTER COLUMN "project_key" SET NOT NULL;

ALTER TABLE "worklog_entry" DROP CONSTRAINT "worklog_entry_pkey";
ALTER TABLE "worklog_entry"
  ADD CONSTRAINT "worklog_entry_pkey" PRIMARY KEY ("project_key", "worklog_id");

-- ============================================================================
-- 6) sync_run: cột tenant (màn hình ops lọc theo dự án; sống sót khi epic bị gỡ)
-- ============================================================================
ALTER TABLE "sync_run" ADD COLUMN "project_key" VARCHAR(32);

UPDATE "sync_run" s
SET "project_key" = t."project_key"
FROM "tracked_epic" t
WHERE s."epic_key" = t."epic_key" AND s."project_key" IS NULL;

UPDATE "sync_run"
SET "project_key" = split_part("epic_key", '-', 1)
WHERE "project_key" IS NULL;

ALTER TABLE "sync_run" ALTER COLUMN "project_key" SET NOT NULL;

CREATE INDEX "idx_syncrun_project" ON "sync_run" ("project_key", "started_at" DESC);

-- ============================================================================
-- 7) tracked_epic: phạm vi theo dõi tổng quát + FK tenant
-- ============================================================================
ALTER TABLE "tracked_epic"
  ADD COLUMN "scope_type" VARCHAR(16) NOT NULL DEFAULT 'ROOT_ISSUE',
  ADD COLUMN "root_jql"   TEXT;

ALTER TABLE "tracked_epic"
  ADD CONSTRAINT "tracked_epic_scope_type_check"
  CHECK ("scope_type" IN ('ROOT_ISSUE', 'JQL'));

-- epic_id là ID số per-site → bỏ unique toàn cục.
-- (Ở migration init đây là UNIQUE INDEX, không phải constraint → DROP INDEX.)
DROP INDEX "tracked_epic_epic_id_key";

-- Trước đây cố ý KHÔNG FK (project chỉ là picklist). Giờ project là tenant sở
-- hữu epic → ràng buộc thật; bước (2) đã đảm bảo mọi project_key hiện có đều
-- có dòng tenant nên VALIDATE pass ngay.
ALTER TABLE "tracked_epic"
  ADD CONSTRAINT "tracked_epic_project_key_fkey" FOREIGN KEY ("project_key")
    REFERENCES "project" ("project_key") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- 8) phase_config_set: ràng buộc tenant (scope GLOBAL có project_key NULL —
--    NULL pass FK tự động, không cần điều kiện riêng)
-- ============================================================================
ALTER TABLE "phase_config_set"
  ADD CONSTRAINT "phase_config_set_project_key_fkey" FOREIGN KEY ("project_key")
    REFERENCES "project" ("project_key") ON DELETE NO ACTION ON UPDATE NO ACTION
    NOT VALID;
ALTER TABLE "phase_config_set" VALIDATE CONSTRAINT "phase_config_set_project_key_fkey";

-- ============================================================================
-- 9) work_calendar: lịch riêng theo dự án (NULL = built-in dùng chung)
-- ============================================================================
ALTER TABLE "work_calendar" ADD COLUMN "project_key" VARCHAR(32);

ALTER TABLE "work_calendar"
  ADD CONSTRAINT "work_calendar_project_key_fkey" FOREIGN KEY ("project_key")
    REFERENCES "project" ("project_key") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "idx_calendar_project" ON "work_calendar" ("project_key");
