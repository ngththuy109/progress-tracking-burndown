// @vitest-environment node
//
// KHÁC các test khác của web (chạy jsdom cho DOM): file này nạp `vite.config.ts`,
// mà nó kéo theo `vite` → `esbuild`. Dưới jsdom, `esbuild` chết vì jsdom thay
// `TextEncoder`/`Uint8Array` làm vỡ bất biến nội bộ của nó. Đây là logic cấu hình
// thuần, không cần DOM → ép chạy môi trường `node`.
import { describe, expect, it } from 'vitest';

import { resolveAllowedHosts, resolveDevHost, resolveWebPort } from '../vite.config';

/**
 * `resolveAllowedHosts` quyết định máy chủ web đã build (`vite preview`) cho phép
 * mở bằng những TÊN HOST nào. Bug gốc: bind `0.0.0.0` nhưng Vite 6 chặn 403 mọi
 * Host không phải IP/localhost, nên máy khác gọi bằng tên máy/tên miền tưởng như
 * "chỉ localhost mới vào được". Mặc định phải MỞ để hết bug; `WEB_ALLOWED_HOSTS`
 * để siết lại khi cần.
 */
describe('resolveAllowedHosts', () => {
  it('mở mọi host khi WEB_ALLOWED_HOSTS bỏ trống — để máy khác gọi bằng tên vẫn vào được', () => {
    expect(resolveAllowedHosts({})).toBe(true);
    expect(resolveAllowedHosts({ WEB_ALLOWED_HOSTS: '' })).toBe(true);
    expect(resolveAllowedHosts({ WEB_ALLOWED_HOSTS: '   ' })).toBe(true);
  });

  it('chỉ toàn dấu phẩy/khoảng trắng cũng coi như bỏ trống → mở mọi host, KHÔNG chặn sạch', () => {
    // `[]` là "chặn tất cả" trong Vite — đúng con bug đang sửa. Phải lùi về `true`.
    expect(resolveAllowedHosts({ WEB_ALLOWED_HOSTS: ',' })).toBe(true);
    expect(resolveAllowedHosts({ WEB_ALLOWED_HOSTS: ' , , ' })).toBe(true);
  });

  it('siết về đúng danh sách host khi được đặt', () => {
    expect(resolveAllowedHosts({ WEB_ALLOWED_HOSTS: 'app.cty.com' })).toEqual(['app.cty.com']);
    expect(resolveAllowedHosts({ WEB_ALLOWED_HOSTS: 'app.cty.com,vm' })).toEqual([
      'app.cty.com',
      'vm',
    ]);
  });

  it('cắt khoảng trắng quanh từng host và bỏ mục rỗng giữa các dấu phẩy', () => {
    expect(resolveAllowedHosts({ WEB_ALLOWED_HOSTS: '  app.cty.com ,, vm ,' })).toEqual([
      'app.cty.com',
      'vm',
    ]);
  });

  it('giữ nguyên tiền tố "." (quy ước khớp subdomain của Vite)', () => {
    expect(resolveAllowedHosts({ WEB_ALLOWED_HOSTS: '.cty.com' })).toEqual(['.cty.com']);
  });
});

/**
 * `resolveWebPort` — lùi về 8080 khi `WEB_PORT` trống hoặc không phải cổng hợp lệ,
 * thay vì để `NaN` lọt xuống `vite preview`. Kèm ở đây để khoá luôn hành vi cổng.
 */
describe('resolveWebPort', () => {
  it('dùng WEB_PORT khi là cổng hợp lệ', () => {
    expect(resolveWebPort({ WEB_PORT: '9090' })).toBe(9090);
  });

  it('lùi về 8080 khi trống, không phải số, hoặc ngoài khoảng 1–65535', () => {
    expect(resolveWebPort({})).toBe(8080);
    expect(resolveWebPort({ WEB_PORT: '' })).toBe(8080);
    expect(resolveWebPort({ WEB_PORT: 'abc' })).toBe(8080);
    expect(resolveWebPort({ WEB_PORT: '0' })).toBe(8080);
    expect(resolveWebPort({ WEB_PORT: '70000' })).toBe(8080);
  });
});

/**
 * `resolveDevHost` — host mà DEV SERVER (`pnpm dev`, cổng 5180) lắng nghe. Bug
 * gốc: khối `server` không đặt `host` nên Vite chỉ nghe `localhost`, máy khác mở
 * bằng IP là không vào được. Mặc định phải MỞ (`0.0.0.0`) để hết bug — đồng bộ
 * với API và máy chủ preview; `WEB_DEV_HOST` để thu hẹp lại khi cần.
 */
describe('resolveDevHost', () => {
  it('mặc định 0.0.0.0 (mọi giao diện) để máy khác mở dev server qua IP', () => {
    expect(resolveDevHost({})).toBe('0.0.0.0');
    expect(resolveDevHost({ WEB_DEV_HOST: '' })).toBe('0.0.0.0');
    expect(resolveDevHost({ WEB_DEV_HOST: '   ' })).toBe('0.0.0.0');
  });

  it('thu hẹp về đúng host được đặt (vd 127.0.0.1 để CHỈ máy này)', () => {
    expect(resolveDevHost({ WEB_DEV_HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(resolveDevHost({ WEB_DEV_HOST: '  192.168.1.5  ' })).toBe('192.168.1.5');
  });
});
