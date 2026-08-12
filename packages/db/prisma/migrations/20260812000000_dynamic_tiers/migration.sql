-- Phân tầng linh động N tầng — DYNAMIC-TIERS-DESIGN.md.
--
-- Tổng quát hoá bộ phase_* (một tầng "Phase" cố định) thành 1..N tầng nhóm logic.
-- Bốn bảng dưới là CON MỚI của phase_config_set — đi đúng bộ máy version/inheritance
-- hiện có (như sub_phase_order). Vòng 1 chỉ THÊM; engine vẫn đọc phase_* nên hành vi
-- không đổi. Backfill sinh tier config mirror + jira_issue.group_path (xem seed).

-- Bảng 7H: định nghĩa một TẦNG nhóm (tổng quát "danh sách Phase" thành 1 tầng bất kỳ).
CREATE TABLE "group_tier" (
  "id"            BIGSERIAL PRIMARY KEY,
  "config_set_id" BIGINT NOT NULL,
  "tier_order"    INTEGER NOT NULL,
  "code"          VARCHAR(32) NOT NULL,
  "label_vi"      TEXT NOT NULL,
  "label_ja"      TEXT,
  "role"          VARCHAR(8) NOT NULL,
  "source_type"   VARCHAR(24) NOT NULL,
  "source_config" JSONB,
  "display_order" INTEGER NOT NULL,

  CONSTRAINT "group_tier_config_set_id_fkey"
    FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_group_tier_order" ON "group_tier"("config_set_id", "tier_order");
CREATE INDEX "idx_group_tier_set" ON "group_tier"("config_set_id");

-- Bảng 7I: giá trị chuẩn của một tầng (tổng quát phase_definition cho mọi tầng).
CREATE TABLE "group_tier_definition" (
  "id"            BIGSERIAL PRIMARY KEY,
  "config_set_id" BIGINT NOT NULL,
  "tier_order"    INTEGER NOT NULL,
  "group_code"    VARCHAR(64) NOT NULL,
  "label_vi"      TEXT NOT NULL,
  "label_ja"      TEXT,
  "color_hex"     CHAR(7),
  "display_order" INTEGER NOT NULL,

  CONSTRAINT "group_tier_definition_config_set_id_fkey"
    FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_group_def" ON "group_tier_definition"("config_set_id", "tier_order", "group_code");
CREATE INDEX "idx_group_def_set" ON "group_tier_definition"("config_set_id", "tier_order", "display_order");

-- Bảng 7J: luật khớp từ khoá → mã tầng (tổng quát phase_match_rule cho mọi tầng).
CREATE TABLE "group_tier_rule" (
  "id"             BIGSERIAL PRIMARY KEY,
  "config_set_id"  BIGINT NOT NULL,
  "tier_order"     INTEGER NOT NULL,
  "keyword"        TEXT NOT NULL,
  "match_mode"     VARCHAR(16) NOT NULL DEFAULT 'CONTAINS',
  "group_code"     VARCHAR(64) NOT NULL,
  "match_priority" INTEGER NOT NULL DEFAULT 50,

  CONSTRAINT "group_tier_rule_config_set_id_fkey"
    FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_group_rule_set" ON "group_tier_rule"("config_set_id", "tier_order", "match_priority");

-- Bảng 7K: mẫu tiêu đề của một tầng (tổng quát phase_title_pattern; chỉ tầng dựa title).
CREATE TABLE "group_tier_title_pattern" (
  "id"             BIGSERIAL PRIMARY KEY,
  "config_set_id"  BIGINT NOT NULL,
  "tier_order"     INTEGER NOT NULL,
  "pattern_text"   TEXT NOT NULL,
  "compiled_regex" TEXT NOT NULL,
  "sort_order"     INTEGER NOT NULL,

  CONSTRAINT "group_tier_title_pattern_config_set_id_fkey"
    FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_group_pattern_set" ON "group_tier_title_pattern"("config_set_id", "tier_order", "sort_order");

-- Tracked scope selector (DYNAMIC-TIERS-DESIGN §6): CONTAINER (mặc định, hàng cũ giữ
-- nguyên nghĩa) hoặc QUERY (JQL, project phẳng). leaf_issue_types = loại issue lá.
ALTER TABLE "tracked_epic"
  ADD COLUMN "scope_type"       VARCHAR(16) NOT NULL DEFAULT 'CONTAINER',
  ADD COLUMN "scope_jql"        TEXT,
  ADD COLUMN "leaf_issue_types" TEXT[] NOT NULL DEFAULT '{}';

-- Vectơ khoá nhóm theo tầng trên lá (DYNAMIC-TIERS-DESIGN §4.2). NULL trước backfill;
-- cấu hình mặc định 1 tầng thì = [phase_code]. phase_code vẫn giữ cho engine Vòng 1.
ALTER TABLE "jira_issue" ADD COLUMN "group_path" JSONB;

-- ── Backfill dữ liệu ĐÃ CÓ ────────────────────────────────────────────────────
-- Sinh MIRROR "một tầng Phase" (tier_order=1, role=PHASE, source=PARENT_TASK_TITLE)
-- cho MỌI bộ phase_config_set hiện có, đúng như deriveDefaultTiersFromPhase (TS).
-- Idempotent bằng NOT EXISTS — chạy lại an toàn. (Cài mới: seed tự sinh group_tier*.)
INSERT INTO "group_tier"
  ("config_set_id", "tier_order", "code", "label_vi", "role", "source_type", "display_order")
SELECT pcs."id", 1, 'PHASE', 'Phase', 'PHASE', 'PARENT_TASK_TITLE', 0
FROM "phase_config_set" pcs
WHERE NOT EXISTS (SELECT 1 FROM "group_tier" gt WHERE gt."config_set_id" = pcs."id");

INSERT INTO "group_tier_definition"
  ("config_set_id", "tier_order", "group_code", "label_vi", "label_ja", "color_hex", "display_order")
SELECT pd."config_set_id", 1, pd."phase_code", pd."label_vi", pd."label_ja", pd."color_hex", pd."display_order"
FROM "phase_definition" pd
WHERE NOT EXISTS (
  SELECT 1 FROM "group_tier_definition" d
  WHERE d."config_set_id" = pd."config_set_id" AND d."tier_order" = 1 AND d."group_code" = pd."phase_code"
);

INSERT INTO "group_tier_rule"
  ("config_set_id", "tier_order", "keyword", "match_mode", "group_code", "match_priority")
SELECT pr."config_set_id", 1, pr."keyword", pr."match_mode", pr."phase_code", pr."match_priority"
FROM "phase_match_rule" pr
WHERE NOT EXISTS (
  SELECT 1 FROM "group_tier_rule" r
  WHERE r."config_set_id" = pr."config_set_id" AND r."tier_order" = 1
    AND r."keyword" = pr."keyword" AND r."group_code" = pr."phase_code"
);

INSERT INTO "group_tier_title_pattern"
  ("config_set_id", "tier_order", "pattern_text", "compiled_regex", "sort_order")
SELECT pt."config_set_id", 1, pt."pattern_text", '', pt."sort_order"
FROM "phase_title_pattern" pt
WHERE NOT EXISTS (
  SELECT 1 FROM "group_tier_title_pattern" g
  WHERE g."config_set_id" = pt."config_set_id" AND g."tier_order" = 1 AND g."pattern_text" = pt."pattern_text"
);

-- group_path = [phase_code] cho lá đã có phase_code (Epic/Task giữ NULL).
UPDATE "jira_issue"
SET "group_path" = to_jsonb(ARRAY["phase_code"])
WHERE "phase_code" IS NOT NULL AND "group_path" IS NULL;
