-- Hierarchy Profile — cấu trúc dự án linh hoạt (docs/FLEXIBLE-HIERARCHY-PROPOSAL.md).
--
-- Hai mảnh:
--
-- 1) `jira_issue.resolved_role` — VAI trong cây (ROOT | GROUP | LEAF), gán lúc
--    đồng bộ theo VỊ TRÍ trong cây chứ không theo tên issue type. Mọi truy vấn
--    "ticket lá" chuyển từ `issue_type = 'SUBTASK'` sang `resolved_role = 'LEAF'`
--    — bước mở khoá để dự án 2 tầng (LEAF là Task con của một ticket root) chạy
--    được mà không sửa thêm truy vấn nào. `issue_type` giữ nguyên làm dữ liệu
--    MÔ TẢ (hiển thị, điều tra sự cố).
--
-- 2) Bảng `hierarchy_profile` — 0..1 dòng cho mỗi `phase_config_set`, mô tả số
--    tầng + nguồn Phase + nguồn hàng/cột Signboard. KHÔNG có dòng = dùng profile
--    mặc định 3 tầng trong mã nguồn (DEFAULT_HIERARCHY_PROFILE) — nhờ vậy seed
--    và dữ liệu có sẵn không phải đổi gì.

-- DEFAULT 'LEAF' chỉ để ADD COLUMN NOT NULL không khoá bảng lâu; giá trị thật
-- được backfill ngay dưới đây và từ đó do worker ghi ở mỗi lần đồng bộ.
ALTER TABLE "jira_issue"
  ADD COLUMN "resolved_role" VARCHAR(8) NOT NULL DEFAULT 'LEAF';

-- Backfill từ issue_type: dữ liệu có sẵn đều thuộc profile 3 tầng cũ nên ánh xạ
-- 1-1. ELSE 'LEAF' vì SUBTASK là giá trị còn lại duy nhất từng được ghi.
UPDATE "jira_issue"
SET "resolved_role" = CASE "issue_type"
  WHEN 'EPIC' THEN 'ROOT'
  WHEN 'TASK' THEN 'GROUP'
  ELSE 'LEAF'
END;

-- Vai lạ (gõ sai, code cũ) phải bị chặn ngay tại DB — Prisma không tự sinh
-- CHECK nên viết tay (C-13).
ALTER TABLE "jira_issue"
  ADD CONSTRAINT "ck_issue_resolved_role"
  CHECK ("resolved_role" IN ('ROOT', 'GROUP', 'LEAF'));

-- Partial index cho truy vấn Signboard, thay `idx_issue_signboard` (vị ngữ cũ
-- theo issue_type không còn khớp WHERE mới nên planner sẽ không dùng nữa —
-- giữ lại chỉ tốn chi phí ghi).
CREATE INDEX "idx_issue_signboard_role"
  ON "jira_issue" (epic_key, phase_code, function_key, task_type)
  WHERE resolved_role = 'LEAF' AND removed_at IS NULL;

DROP INDEX IF EXISTS "idx_issue_signboard";

-- Bảng 7G — con của phase_config_set, hưởng trọn version + preview→confirm +
-- rollback của bộ cấu hình (xoá theo cascade như 7B–7F).
CREATE TABLE "hierarchy_profile" (
  "id"                BIGSERIAL PRIMARY KEY,
  "config_set_id"     BIGINT      NOT NULL,

  -- Mảng {role, issueTypes?} theo tầng — hình dạng do zod `hierarchyProfileSchema`
  -- giữ ở tầng API; DB chỉ giữ ràng buộc "là mảng JSON".
  "levels"            JSONB       NOT NULL,

  "phase_source_type" VARCHAR(24) NOT NULL,
  "phase_source_ref"  VARCHAR(64),
  "phase_group_level" SMALLINT,

  "sb_row_source"     VARCHAR(16) NOT NULL,
  "sb_row_ref"        VARCHAR(64) NOT NULL,
  "sb_col_source"     VARCHAR(16) NOT NULL,
  "sb_col_ref"        VARCHAR(64) NOT NULL,

  CONSTRAINT "hierarchy_profile_config_set_id_key" UNIQUE ("config_set_id"),
  CONSTRAINT "hierarchy_profile_config_set_id_fkey"
    FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "ck_hierarchy_phase_source_type"
    CHECK ("phase_source_type" IN ('GROUP_TITLE', 'SELF_TITLE_SLOT', 'FIELD', 'FIXED')),
  CONSTRAINT "ck_hierarchy_sb_row_source" CHECK ("sb_row_source" IN ('TITLE_SLOT', 'FIELD')),
  CONSTRAINT "ck_hierarchy_sb_col_source" CHECK ("sb_col_source" IN ('TITLE_SLOT', 'FIELD')),
  CONSTRAINT "ck_hierarchy_levels_is_array" CHECK (jsonb_typeof("levels") = 'array')
);
