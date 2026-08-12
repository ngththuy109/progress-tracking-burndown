-- Lưu tổng hợp N tầng (DYNAMIC-TIERS-DESIGN.md §4.3) + snapshot theo tầng — Vòng 4.
--
-- CHỈ THÊM (C-13). `group_rollup` tổng quát `phase_rollup` cho MỌI nút prefix của
-- group_path; `daily_snapshot.per_tier` giữ cây tổng hợp mỗi ngày. Engine đã TÍNH được
-- (computeGroupRollups / buildTierSnapshotForDay ở Vòng 2) — vòng này ghi xuống + phục
-- vụ drill-down. Chỉ ghi khi cấu hình ĐA TẦNG; config 1 tầng thì phase_rollup + per_phase
-- đã đủ nên hai chỗ này để trống — không đổi hành vi Epic đang chạy.

-- Bảng 7L: rollup của một nút prefix (tổng quát phase_rollup). Khoá tự nhiên
-- (epic_key, group_key) với group_key = JSON.stringify(group_path) — chuỗi ổn định,
-- so khớp UPSERT được (JSONB không so bằng = trực tiếp trong khoá).
CREATE TABLE "group_rollup" (
  "epic_key"                  VARCHAR(32) NOT NULL,
  "group_key"                 TEXT NOT NULL,
  "tier_order"                INTEGER NOT NULL,
  "group_path"                JSONB NOT NULL,
  "plan_start"                DATE,
  "plan_end"                  DATE,
  "plan_workdays"             INTEGER,
  "actual_start"              DATE,
  "actual_end"                DATE,
  "actual_end_is_provisional" BOOLEAN NOT NULL DEFAULT FALSE,
  "total_original_s"          BIGINT NOT NULL DEFAULT 0,
  "subtask_count"             INTEGER NOT NULL DEFAULT 0,
  "missing_date_count"        INTEGER NOT NULL DEFAULT 0,
  "computed_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "group_rollup_pkey" PRIMARY KEY ("epic_key", "group_key"),
  CONSTRAINT "group_rollup_epic_key_fkey"
    FOREIGN KEY ("epic_key") REFERENCES "tracked_epic"("epic_key")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_group_rollup_epic" ON "group_rollup"("epic_key", "tier_order");

-- Cây tổng hợp theo tầng của một ngày (song song per_phase). NULL với Epic 1 tầng.
ALTER TABLE "daily_snapshot" ADD COLUMN "per_tier" JSONB;
