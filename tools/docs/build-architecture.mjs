#!/usr/bin/env node
/**
 * Dựng lại trang tổng quan kiến trúc: tools/docs/architecture.src.html → docs/architecture-overview.html.
 *
 * VÌ SAO PHẢI CÓ BƯỚC BUILD: file nguồn viết sơ đồ bằng mermaid (khối
 * `<pre class="mermaid">`). Nếu để nguyên và nhờ trình duyệt tải mermaid từ CDN
 * thì trang KHÔNG hiện ở môi trường chặn CDN — đúng môi trường dự án này chạy
 * (xem README "No Prisma engine download"). Nên script này PRE-RENDER từng sơ đồ
 * thành SVG TĨNH nhúng thẳng: trang cuối không cần JS/CDN, mở là hiện, kể cả offline.
 *
 * Dùng: `pnpm docs:build-arch` (sau khi sửa architecture.src.html).
 *
 * PHỤ THUỘC — cố ý KHÔNG thêm vào package.json để giữ `pnpm install` (và CI) nhẹ:
 *   - mermaid: tự cài vào cache cục bộ `tools/docs/.cache` ở lần chạy đầu (cần
 *     mạng REGISTRY — không phải CDN; registry vẫn tới được như `pnpm install`).
 *   - Chromium: mượn bản Playwright đã có (`@playwright/test`, vốn dùng cho e2e).
 */

/* global window -- các hàm truyền vào page.evaluate() chạy trong trình duyệt, nơi `window` tồn tại. */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const SRC = join(here, 'architecture.src.html');
const OUT = join(repoRoot, 'docs', 'architecture-overview.html');
const CACHE = join(here, '.cache');
const MERMAID_VERSION = '11';

/**
 * Bảo đảm mermaid có trong cache cục bộ; trả về đường dẫn bản UMD (`mermaid.min.js`
 * đặt `window.mermaid`). Chỉ cài một lần — lần sau thấy sẵn thì bỏ qua.
 */
function ensureMermaid() {
  const umd = join(CACHE, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
  if (existsSync(umd)) return umd;

  mkdirSync(CACHE, { recursive: true });
  const cachePkg = join(CACHE, 'package.json');
  if (!existsSync(cachePkg)) {
    writeFileSync(cachePkg, `${JSON.stringify({ name: 'arch-doc-cache', private: true }, null, 2)}\n`);
  }
  console.log(`• Cài mermaid@${MERMAID_VERSION} vào cache cục bộ (lần đầu, cần mạng registry)…`);
  execSync(`npm install --no-audit --no-fund --loglevel=error mermaid@${MERMAID_VERSION}`, {
    cwd: CACHE,
    stdio: 'inherit',
  });
  if (!existsSync(umd)) throw new Error(`Cài mermaid xong nhưng không thấy ${umd}`);
  return umd;
}

/** Dò một Chromium do Playwright cài sẵn (không tải thêm). */
function findInstalledChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  // Ưu tiên bản 'chrome' đầy đủ; lùi về 'headless_shell'.
  const dirs = readdirSync(base).filter((d) => d.startsWith('chromium'));
  const rels = [
    ['chrome-linux', 'chrome'],
    ['chrome-linux', 'headless_shell'],
  ];
  for (const d of dirs.sort().reverse()) {
    for (const [sub, bin] of rels) {
      const p = join(base, d, sub, bin);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * Mở Chromium: thử bản Playwright tự quản trước; nếu số hiệu build lệch (hay gặp)
 * thì lùi sang bản đã cài trong PLAYWRIGHT_BROWSERS_PATH kèm executablePath.
 */
async function launchChromium() {
  const require = createRequire(join(repoRoot, 'package.json'));
  const pw = await import(require.resolve('@playwright/test'));
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error('Không lấy được chromium từ @playwright/test');
  try {
    return await chromium.launch({ args: ['--no-sandbox'] });
  } catch (firstErr) {
    const executablePath = findInstalledChromium();
    if (!executablePath) {
      throw new Error(
        `Không mở được Chromium và không dò ra bản cài sẵn. ` +
          `Chạy \`pnpm exec playwright install chromium\` rồi thử lại. Lỗi gốc: ${String(firstErr)}`,
      );
    }
    return chromium.launch({ executablePath, args: ['--no-sandbox'] });
  }
}

async function main() {
  const mermaidUmd = ensureMermaid();

  const src = readFileSync(SRC, 'utf8');
  const title = (src.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? 'Kiến trúc Burndown Engine').trim();
  const style = src.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const body = src.slice(src.indexOf('</style>') + '</style>'.length).trim();

  // Tách định nghĩa từng sơ đồ, thay bằng placeholder ổn định.
  const defs = [];
  const bodyMarked = body.replace(/<pre class="mermaid">([\s\S]*?)<\/pre>/g, (_m, def) => {
    const i = defs.length;
    defs.push(def.trim());
    return `@@MERMAID_${i}@@`;
  });
  if (defs.length === 0) throw new Error('Không thấy khối <pre class="mermaid"> nào trong nguồn');
  console.log(`• ${defs.length} sơ đồ cần render.`);

  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ path: mermaidUmd });
    await page.waitForFunction(() => typeof window.mermaid !== 'undefined');
    // htmlLabels:false → nhãn là SVG <text> thuần (không phải <foreignObject> HTML),
    // nên SVG mang sẵn vị trí chữ và KHÔNG reflow/cắt khi mở ở máy có font khác.
    await page.evaluate(() =>
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      }),
    );

    const svgs = [];
    for (let i = 0; i < defs.length; i++) {
      // id CỐ ĐỊNH theo chỉ số ⇒ dựng lại cho ra byte y hệt (diff git sạch).
      // KHÔNG đụng gì thêm vào SVG: mermaid scope CSS nội bộ theo id thẻ <svg>
      // (#id .flowchart-link{fill:none}…). Xoá id là mất scope → cạnh bị tô đen.
      const svg = await page.evaluate(
        async ({ def, id }) => (await window.mermaid.render(id, def)).svg,
        { def: defs[i], id: `archdia-${i}` },
      );
      svgs.push(svg);
      console.log(`  sơ đồ ${i + 1}: ${svg.length} bytes SVG`);
    }

    let finalBody = bodyMarked;
    for (let i = 0; i < svgs.length; i++) {
      finalBody = finalBody.replace(`@@MERMAID_${i}@@`, `<div class="mermaid-svg">${svgs[i]}</div>`);
    }
    if (finalBody.includes('@@MERMAID_')) throw new Error('Còn placeholder sơ đồ chưa thay');

    const extraCss = `
/* SVG mermaid đã pre-render — co giãn trong thẻ .diagram, không cần JS */
.diagram .mermaid-svg { display: flex; justify-content: center; }
.diagram .mermaid-svg svg { max-width: 100%; height: auto; }
`;

    const out = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
/* reset tối thiểu (bản artifact vốn được khung publish bọc sẵn) */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
img, svg { max-width: 100%; }
${style}${extraCss}</style>
</head>
<body>
${finalBody}
</body>
</html>
`;

    writeFileSync(OUT, out);
    console.log(`✔ Đã ghi ${OUT} (${out.length} bytes).`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('\n✖ Dựng trang kiến trúc thất bại:');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
