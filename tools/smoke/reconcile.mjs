#!/usr/bin/env node
/**
 * Chạy đối soát bằng tay — runbook mục `DATA_DRIFT`.
 *
 *   pnpm reconcile -- --epic=PAY-100          # chỉ IN kết quả
 *   pnpm reconcile -- --epic=PAY-100 --fix    # in rồi tự đẩy job chạy bù
 *
 * MẶC ĐỊNH KHÔNG SỬA GÌ. Chạy bù toàn bộ mất vài phút và chiếm hạn mức gọi Jira
 * của cả hệ thống, nên bắt người vận hành xác nhận bằng một cờ tường minh.
 */

const args = process.argv.slice(2);
const epicKey = args.find((a) => a.startsWith('--epic='))?.slice('--epic='.length);
const fix = args.includes('--fix');
const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';

if (epicKey === undefined || epicKey === '') {
  console.error('Thiếu tham số. Ví dụ: pnpm reconcile -- --epic=PAY-100 [--fix]');
  process.exit(2);
}

const res = await fetch(`${BASE_URL}/api/epic/${epicKey}/reconcile?fix=${fix ? 'true' : 'false'}`, {
  method: 'POST',
});

if (!res.ok) {
  console.error(`Không đối soát được ${epicKey}: HTTP ${res.status}. Xem docs/RUNBOOK.md.`);
  process.exit(1);
}

const body = await res.json();
const percent = (body.driftRatio * 100).toFixed(3);

console.log(`Epic:        ${epicKey}`);
console.log(`Tổng DB:     ${(body.totalDbS / 3600).toFixed(1)} giờ`);
console.log(`Tổng Jira:   ${(body.totalJiraS / 3600).toFixed(1)} giờ`);
console.log(`Lệch:        ${percent}%  (ngưỡng 0.5%)`);
console.log('');

if (body.perIssue.length === 0) {
  console.log('Không có issue nào lệch.');
} else {
  // Ba loại lệch có nguyên nhân hoàn toàn khác nhau — in riêng từng loại.
  console.log(`${body.perIssue.length} issue lệch:`);
  for (const d of body.perIssue) {
    console.log(`  ${d.kind.padEnd(16)} ${d.issueKey.padEnd(12)} DB=${d.dbS ?? '—'}  Jira=${d.jiraS ?? '—'}`);
  }
}

console.log('');
if (body.backfillQueued === true) {
  console.log('Đã đẩy job chạy bù toàn bộ. Theo dõi ở /ops.');
} else if (body.driftRatio > 0.005) {
  console.log('Vượt ngưỡng nhưng CHƯA chạy bù. Thêm cờ --fix nếu muốn chạy.');
}

// Vượt ngưỡng thì thoát khác 0 để nối được vào cảnh báo tự động.
process.exit(body.driftRatio > 0.005 ? 1 : 0);
