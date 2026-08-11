-- Bảng `sub_phase_order` — thứ tự Sub-phase TRONG TỪNG PHASE trên bảng Signboard.
--
-- VÌ SAO CẦN: T-35 nhóm cột Signboard theo Sub-phase nhưng "mượn" display_order
-- của phase_definition để xếp thứ tự. PM phản hồi: khu ② Phase list là setting
-- của PHASE, không phải chỗ chỉnh thứ tự Sub-phase thuộc một Phase cố định —
-- cần chỗ khai riêng. Bảng này là phần cấu hình đó, đi đúng bộ máy version của
-- phase_config_set (lưu = version mới, rollback được, kế thừa GLOBAL→PROJECT).
--
-- `sub_phase_code` so với `[Sub-phase]` trong tiêu đề Sub-task SAU chuẩn hoá
-- NFKC + chữ thường (E-31). Phase không có Sub-phase thì không có dòng nào.

CREATE TABLE "sub_phase_order" (
  "id"             BIGSERIAL PRIMARY KEY,
  "config_set_id"  BIGINT NOT NULL,
  "phase_code"     VARCHAR(24) NOT NULL,
  "sub_phase_code" VARCHAR(64) NOT NULL,
  "display_order"  INTEGER NOT NULL,

  CONSTRAINT "sub_phase_order_config_set_id_fkey"
    FOREIGN KEY ("config_set_id") REFERENCES "phase_config_set"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_sub_phase"
  ON "sub_phase_order"("config_set_id", "phase_code", "sub_phase_code");

CREATE INDEX "idx_subphase_set"
  ON "sub_phase_order"("config_set_id", "phase_code", "display_order");
