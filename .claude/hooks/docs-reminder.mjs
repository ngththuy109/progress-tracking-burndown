#!/usr/bin/env node
/**
 * PostToolUse hook — nhắc cập nhật TÀI LIỆU (docs) sau khi chỉnh sửa mã nguồn.
 *
 * Vì sao cần: repo có bộ tài liệu phong phú (README.md, docs/*.md,
 * docs/tasks/*.md) rất dễ bị lệch với code khi sửa nhanh. Hook này chèn một lời
 * nhắc vào NGỮ CẢNH của Claude ngay sau mỗi lần Edit/Write một file NGUỒN, để
 * agent tự rà soát và cập nhật tài liệu liên quan nếu cần.
 *
 * Thiết kế để KHÔNG gây ồn:
 *   - Bỏ qua khi đang sửa chính tài liệu (*.md/*.mdx), file trong .claude/, hay
 *     file không phải mã nguồn (ảnh, lockfile, JSON/yaml config…).
 *   - Bỏ qua file test (*.test.*, *.spec.*, __tests__/) — sửa test hiếm khi kéo
 *     theo đổi tài liệu.
 *   - Chỉ nhắc MỘT LẦN cho mỗi file trong mỗi phiên (marker theo session_id),
 *     nên sửa cùng một file nhiều lần trong một task cũng không lặp lời nhắc.
 *   - KHÔNG BAO GIỜ chặn thao tác: mọi lỗi đều nuốt và exit 0.
 *
 * Cách vô hiệu hoá tạm thời: xoá/đổi tên hook trong .claude/settings.json, hoặc
 * mở menu /hooks trong Claude Code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Đọc toàn bộ stdin (JSON do Claude Code truyền vào). */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

/** Luôn thoát 0. Nếu có output thì in JSON điều khiển cho Claude Code. */
function done(output) {
  if (output) process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

const raw = await readStdin();

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  done(); // stdin không phải JSON hợp lệ → im lặng bỏ qua
}

const toolInput = (payload && payload.tool_input) || {};
const filePath = toolInput.file_path || toolInput.filePath || '';
if (!filePath) done();

const rel = String(filePath).replace(/\\/g, '/');
const lower = rel.toLowerCase();

// 1) Bỏ qua khi sửa CHÍNH tài liệu, hoặc file thư mục sinh ra/không phải nguồn.
if (
  lower.endsWith('.md') ||
  lower.endsWith('.mdx') ||
  lower.endsWith('.markdown') ||
  lower.includes('/.claude/') ||
  lower.includes('/node_modules/') ||
  lower.includes('/dist/') ||
  lower.includes('/coverage/') ||
  lower.includes('/.git/')
) {
  done();
}

// 2) Chỉ nhắc với MÃ NGUỒN thực sự; bỏ qua test.
const isSource = /\.(ts|tsx|js|jsx|mjs|cjs|prisma|sql|css|scss|vue|svelte)$/.test(lower);
const isTest = /\.(test|spec)\.[a-z]+$/.test(lower) || /(^|\/)__tests__\//.test(lower);
if (!isSource || isTest) done();

// 3) De-dup: mỗi file chỉ nhắc MỘT LẦN trong mỗi phiên → không spam.
try {
  const sessionId = String((payload && payload.session_id) || 'no-session').replace(
    /[^a-zA-Z0-9_-]/g,
    '_',
  );
  const dir = path.join(os.tmpdir(), 'claude-docs-reminder', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, crypto.createHash('sha1').update(rel).digest('hex'));
  if (fs.existsSync(marker)) done(); // đã nhắc file này trong phiên rồi
  fs.writeFileSync(marker, rel);
} catch {
  // FS lỗi → fail-open: vẫn nhắc, thà thừa còn hơn bỏ sót.
}

const message = [
  `📝 Nhắc cập nhật tài liệu — bạn vừa sửa mã nguồn: \`${rel}\`.`,
  `Trước khi kết thúc lượt này, hãy rà soát nhanh xem thay đổi có làm LỆCH tài liệu không và cập nhật cho khớp NẾU cần:`,
  `  • README.md — tổng quan, cách chạy, biến môi trường, script.`,
  `  • docs/ — ARCHITECTURE, AUTH, ONBOARDING, RUNBOOK, PHASE-MAPPING, UAT-CHECKLIST…`,
  `  • docs/tasks/ — nếu đổi phạm vi/hành vi của một task (T-xx).`,
  `  • JSDoc / README trong package liên quan (apps/*, packages/*).`,
  `Nếu không có tài liệu nào cần đổi thì BỎ QUA — đừng chỉnh sửa thừa. (Lời nhắc này chỉ hiện một lần cho mỗi file trong phiên.)`,
].join('\n');

done({
  suppressOutput: true, // không đổ JSON vào transcript của người dùng…
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: message, // …nhưng vẫn chèn lời nhắc vào ngữ cảnh của Claude
  },
});
