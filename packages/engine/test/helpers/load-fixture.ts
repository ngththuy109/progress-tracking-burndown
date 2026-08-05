import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoldenFixture } from './fixture-types.js';
import { runBurndown, runInherit, runParse, runSignboard } from './run-engine.js';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

/** Mọi mã golden dataset đang có trên đĩa, sắp theo tên. */
export function goldenIds(): string[] {
  return readdirSync(FIXTURE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^GD-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function fixturePath(id: string, file: string): string {
  return join(FIXTURE_DIR, id, file);
}

export function loadInput(id: string): GoldenFixture {
  return readJson(fixturePath(id, 'input.json')) as GoldenFixture;
}

export function loadExpected(id: string): Record<string, unknown> {
  return readJson(fixturePath(id, 'expected.json')) as Record<string, unknown>;
}

export function hasReadme(id: string): boolean {
  return existsSync(fixturePath(id, 'README.md'));
}

/**
 * Bỏ mọi khoá bắt đầu bằng `_` trước khi so sánh.
 *
 * `_how` trong `expected.json` là phần GHI CÁCH TÍNH TAY — bắt buộc phải có
 * (meta-test kiểm), nhưng nó là tài liệu chứ không phải dữ liệu.
 */
export function stripDocs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDocs);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith('_')) continue;
      out[k] = stripDocs(v);
    }
    return out;
  }
  return value;
}

/** Chạy fixture qua đúng nhánh engine tương ứng với `kind`. */
export function runFixture(fixture: GoldenFixture): unknown {
  switch (fixture.kind) {
    case 'burndown':
      return runBurndown(fixture);
    case 'parse':
      return runParse(fixture);
    case 'signboard':
      return runSignboard(fixture);
    case 'inherit':
      return runInherit(fixture);
    default: {
      const unknownKind = (fixture as { kind?: unknown }).kind;
      throw new Error(`Fixture khai kind = "${String(unknownKind)}", không có nhánh nào xử lý.`);
    }
  }
}

/**
 * Đưa kết quả engine về đúng dạng JSON thuần để so với `expected.json`.
 *
 * `Set` và `Map` không sống sót qua JSON, và `undefined` biến mất — chuẩn hoá ở
 * đây để hai bên so sánh trên cùng một luật chơi.
 */
export function toPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
