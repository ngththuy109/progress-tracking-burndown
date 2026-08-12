-- Tracked scope QUERY (DYNAMIC-TIERS-DESIGN §6, R-F) — Vòng 3.4. CHỈ THÊM/nới (C-13).
--
-- Scope QUERY (project phẳng) KHÔNG có issue container nền, nên `epic_id` phải cho NULL.
-- @unique trên cột nullable ở Postgres: nhiều NULL vẫn khác nhau ⇒ nhiều scope QUERY được.
-- Hàng CONTAINER cũ vẫn có epic_id NOT NULL như thường — không đổi.
ALTER TABLE "tracked_epic" ALTER COLUMN "epic_id" DROP NOT NULL;
