import { describe, it, expect } from 'vitest';
import { createLdapConfigLoader } from './ldap-config.adapters.js';
import { ldapConfigRow } from '../test-fakes.js';

describe('createLdapConfigLoader — cache TTL ~10s', () => {
  it('trong TTL chỉ truy vấn MỘT lần; hết TTL truy vấn lại', async () => {
    let t = 0;
    let calls = 0;
    const loader = createLdapConfigLoader(
      () => {
        calls += 1;
        return Promise.resolve(ldapConfigRow());
      },
      { ttlMs: 10_000, now: () => t },
    );

    await loader.load();
    t = 9_999;
    await loader.load();
    expect(calls).toBe(1);

    t = 10_000; // đúng mép TTL → cache nguội
    await loader.load();
    expect(calls).toBe(2);
  });

  it('invalidate() vứt cache ngay — admin lưu xong thấy config mới lập tức', async () => {
    let calls = 0;
    const loader = createLdapConfigLoader(() => {
      calls += 1;
      return Promise.resolve(null);
    });
    await loader.load();
    loader.invalidate();
    await loader.load();
    expect(calls).toBe(2);
  });

  it('truy vấn hỏng KHÔNG bị cache — lần sau thử lại ngay', async () => {
    let calls = 0;
    const loader = createLdapConfigLoader(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('db chết')) : Promise.resolve(null);
    });
    await expect(loader.load()).rejects.toThrow('db chết');
    // Promise rejected đã bị vứt khỏi cache (dọn bất đồng bộ) → lượt sau gọi lại.
    await Promise.resolve(); // nhường một tick cho handler dọn cache chạy
    expect(await loader.load()).toBeNull();
    expect(calls).toBe(2);
  });
});
