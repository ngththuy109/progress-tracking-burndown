// @vitest-environment node
//
// KHÁC các test khác của web (chạy jsdom cho DOM): file này nạp `vite.config.ts`,
// mà nó kéo theo `vite` → `esbuild`. Dưới jsdom, `esbuild` chết vì jsdom thay
// `TextEncoder`/`Uint8Array` làm vỡ bất biến nội bộ của nó. Đây là logic cấu hình
// thuần, không cần DOM → ép chạy môi trường `node`.
import { describe, expect, it } from 'vitest';

import { buildProxy, resolveAllowedHosts, resolveDevHost, resolveWebPort } from '../vite.config';

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

/**
 * `buildProxy` — bảng proxy CHUNG cho dev server và preview. Bug gốc: proxy chỉ
 * khai `/api`, nên `POST /auth/login` (đăng nhập LDAP, server phục vụ ở GỐC ngoài
 * `/api`) bị Vite nuốt và trả 404 — form báo "Sign-in failed" DÙ mật khẩu đúng vì
 * request chưa bao giờ tới API. `/auth` PHẢI được proxy sang API; và KHÔNG được
 * mang shim danh tính dev (nó chính là endpoint đăng nhập).
 */
describe('buildProxy', () => {
  const target = 'http://localhost:3000';

  it('proxy CẢ /api LẪN /auth sang API — thiếu /auth thì login POST không bao giờ tới API', () => {
    const proxy = buildProxy(target, null);
    expect(Object.keys(proxy)).toEqual(expect.arrayContaining(['/api', '/auth']));
    expect(proxy['/api']).toMatchObject({ target });
    expect(proxy['/auth']).toMatchObject({ target });
  });

  it('KHÔNG chèn danh tính dev vào /auth — đó là endpoint đăng nhập, danh tính do LDAP quyết định', () => {
    const identity = { header: 'x-user-id', user: 'dev@test.test' };
    const proxy = buildProxy(target, identity);
    // `/api` nhận shim danh tính (có `configure`); `/auth` thì KHÔNG.
    expect(proxy['/api']).toHaveProperty('configure');
    expect(proxy['/auth']).not.toHaveProperty('configure');
  });

  it('preview (identity=null): cả hai route đều KHÔNG chèn danh tính', () => {
    const proxy = buildProxy(target, null);
    expect(proxy['/api']).not.toHaveProperty('configure');
    expect(proxy['/auth']).not.toHaveProperty('configure');
  });
});
