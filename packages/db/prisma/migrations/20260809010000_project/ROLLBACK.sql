-- Kịch bản rollback cho migration 20260809010000_project
-- CONVENTIONS.md C-13: mỗi migration phải có kịch bản rollback.
--
-- CẢNH BÁO: mất danh mục Project. Việc gán PM (app_user.projects) KHÔNG bị đụng
-- tới, nhưng sau rollback API sẽ không còn danh sách để kiểm PM gán đúng project.

DROP TABLE IF EXISTS "project";
