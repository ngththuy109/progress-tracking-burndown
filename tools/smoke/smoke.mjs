#!/usr/bin/env node
/**
 * Kiểm tra nhanh sau khi triển khai.
 *
 * Chạy DƯỚI 30 GIÂY và thoát khác 0 khi có gì sai — để nối được vào quy trình
 * triển khai tự động. Một script chỉ in ra rồi luôn thoát 0 thì không chặn được
 * lần triển khai hỏng nào.
 */

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 5000);

/** @type {{name: string, ok: boolean, detail: string}[]} */
const results = [];

async function check(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: `${detail} (${Date.now() - startedAt}ms)` });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

async function fetchJson(path, { expectStatus = 200 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { signal: controller.signal });
    if (res.status !== expectStatus) {
      throw new Error(`${path} trả HTTP ${res.status}, mong đợi ${expectStatus}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

await check('API còn sống', async () => {
  const res = await fetchJson('/healthz');
  const body = await res.json();
  // `healthz` trả 503 khi có thành phần chết, nên tới đây là mọi thứ đã "ok".
  const down = Object.entries(body.components ?? {}).filter(([, v]) => v !== 'ok');
  if (down.length > 0) throw new Error(`Thành phần chết: ${down.map(([k]) => k).join(', ')}`);
  return `postgres + redis ok`;
});

await check('Số đo Prometheus phát ra được', async () => {
  const res = await fetchJson('/metrics');
  const text = await res.text();
  if (!text.includes('# TYPE')) throw new Error('/metrics không đúng định dạng Prometheus');
  return `${text.split('\n').length} dòng`;
});

await check('Cấu hình Phase đọc được', async () => {
  const res = await fetchJson('/api/config/phase');
  const body = await res.json();
  // Thiếu bộ Mặc định là hỏng cấu hình, không phải hỏng dữ liệu — hệ thống sẽ
  // phân loại mọi Task vào "Chưa phân loại" mà không báo gì.
  if (!Array.isArray(body.phaseDefinitions) || body.phaseDefinitions.length === 0) {
    throw new Error('Chưa có Phase nào trong cấu hình đang hiệu lực — chạy seed trước');
  }
  return `${body.phaseDefinitions.length} Phase`;
});

await check('Sổ đăng ký Epic đọc được', async () => {
  const res = await fetchJson('/api/epics');
  const body = await res.json();
  if (!Array.isArray(body.epics)) throw new Error('/api/epics không trả mảng epics');
  return `${body.epics.length} Epic đang theo dõi`;
});

await check('Số liệu vận hành đọc được', async () => {
  const res = await fetchJson('/api/ops/health');
  const body = await res.json();
  if (typeof body.collectedAt !== 'string') {
    throw new Error('/api/ops/health thiếu collectedAt — dashboard sẽ không biết dữ liệu cũ hay mới');
  }
  return `lấy lúc ${body.collectedAt}`;
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`);
}

if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} mục KHÔNG đạt. Xem docs/RUNBOOK.md.`);
  process.exit(1);
}

console.log(`\n${results.length}/${results.length} mục đạt.`);
