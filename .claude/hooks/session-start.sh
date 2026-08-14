#!/bin/bash
# SessionStart hook — chuẩn bị TRỌN BỘ phụ thuộc để test/lint/chạy server hoạt
# động ngay trong phiên Claude Code on the web, không phải làm tay mỗi lần.
#
# Vì sao cần: container web clone lại repo MỚI mỗi phiên nên không có node_modules.
# Muốn chạy được phải:
#   1) pnpm install     — link deps. KHÔNG còn bước build native nào: engine regex
#                         re2 đã chuyển sang bản WebAssembly `re2-wasm` (xem
#                         packages/engine/src/parser/safe-regex.ts), nên install
#                         chạy được offline, không cần toolchain C++.
#   2) pnpm db:generate — sinh Prisma Client (postinstall của @prisma/engines bị
#                         chặn để không tải binary từ CDN — xem README)
#
# Cả hai gộp trong `pnpm preflight` (tools/dev/preflight.mjs): nó CHỈ chạy bước
# nào còn THIẾU, nên container được cache thì phiên sau gần như tức thì. Cùng một
# đường chuẩn bị với máy local (`pnpm dev` tự gọi preflight qua `predev`).
#
# Đồng bộ (không async): bảo đảm deps sẵn sàng TRƯỚC khi phiên bắt đầu, tránh
# việc agent chạy test/lint lúc chưa cài xong.
set -euo pipefail

# Chỉ chạy trong môi trường remote (Claude Code on the web). Máy local tự setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}"

echo "[session-start] Chuẩn bị môi trường (pnpm preflight — install + prisma generate khi thiếu)…"
pnpm preflight

echo "[session-start] Xong — sẵn sàng: pnpm dev / pnpm test / pnpm lint."
