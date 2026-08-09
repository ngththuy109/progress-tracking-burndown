#!/bin/bash
# SessionStart hook — cài TRỌN BỘ phụ thuộc để test/lint/chạy server hoạt động
# ngay trong phiên Claude Code on the web, không phải làm tay mỗi lần.
#
# Vì sao cần: container web clone lại repo MỚI mỗi phiên nên không có node_modules.
# Muốn chạy được phải:
#   1) pnpm install    — link deps + BUILD re2 native (bắt buộc: fallback RegExp
#                        gốc làm mất lớp chống ReDoS và có test đỏ — safe-regex.ts)
#   2) pnpm db:generate — sinh Prisma Client (postinstall của @prisma/engines bị
#                        chặn để không tải binary từ CDN — xem README)
#
# CHẠY TUẦN TỰ, KHÔNG gộp `prisma generate` vào `postinstall`: prisma generate tự
# chạy `pnpm add @prisma/client` → lại kích hoạt postinstall → ĐỆ QUY VÔ HẠN.
#
# Đồng bộ (không async): bảo đảm deps sẵn sàng TRƯỚC khi phiên bắt đầu, tránh
# việc agent chạy test/lint lúc chưa cài xong. Container được cache sau khi hook
# xong nên các phiên sau gần như tức thì.
set -euo pipefail

# Chỉ chạy trong môi trường remote (Claude Code on the web). Máy local tự setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}"

echo "[session-start] pnpm install (link deps + build re2)…"
pnpm install

echo "[session-start] prisma generate (sinh Prisma Client)…"
pnpm db:generate

echo "[session-start] Xong — sẵn sàng: pnpm dev / pnpm test / pnpm lint."
