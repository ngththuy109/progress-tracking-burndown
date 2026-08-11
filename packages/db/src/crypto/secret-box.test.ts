import { describe, expect, it } from 'vitest';
import {
  open,
  parseEncryptionKey,
  seal,
  SECRET_KEY_BYTES,
  SecretBoxError,
} from './secret-box.js';

const KEY = Buffer.alloc(SECRET_KEY_BYTES, 7);
const OTHER_KEY = Buffer.alloc(SECRET_KEY_BYTES, 8);

describe('secret-box (AES-256-GCM cho Jira token)', () => {
  it('seal → open trả lại đúng plaintext (kể cả unicode)', () => {
    const token = 'ATATT3xFfGF0-ví-dụ-トークン';
    expect(open(seal(token, KEY), KEY)).toBe(token);
  });

  it('cùng plaintext, hai lần seal ra hai chuỗi khác nhau (IV ngẫu nhiên)', () => {
    expect(seal('abc', KEY)).not.toBe(seal('abc', KEY));
  });

  it('định dạng đầu ra là v1:<iv>:<tag>:<ct>', () => {
    const parts = seal('abc', KEY).split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it('khóa sai → SecretBoxError, không trả rác im lặng', () => {
    expect(() => open(seal('abc', KEY), OTHER_KEY)).toThrow(SecretBoxError);
  });

  it('ciphertext bị sửa 1 ký tự → SecretBoxError (GCM tag mismatch)', () => {
    const sealed = seal('abc', KEY);
    const idx = sealed.length - 2;
    const flipped = sealed.slice(0, idx) + (sealed[idx] === 'A' ? 'B' : 'A') + sealed.slice(idx + 1);
    expect(() => open(flipped, KEY)).toThrow(SecretBoxError);
  });

  it('chuỗi sai định dạng / phiên bản lạ → SecretBoxError', () => {
    expect(() => open('không-phải-token', KEY)).toThrow(SecretBoxError);
    expect(() => open('v9:a:b:c', KEY)).toThrow(SecretBoxError);
  });

  describe('parseEncryptionKey', () => {
    it('nhận base64 của đúng 32 byte', () => {
      expect(parseEncryptionKey(KEY.toString('base64'))).toEqual(KEY);
    });

    it('thiếu env → SecretBoxError kèm hướng dẫn sinh khóa', () => {
      expect(() => parseEncryptionKey(undefined)).toThrow(/APP_ENCRYPTION_KEY/);
      expect(() => parseEncryptionKey('')).toThrow(SecretBoxError);
    });

    it('sai độ dài → SecretBoxError', () => {
      expect(() => parseEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow(
        SecretBoxError,
      );
    });
  });
});
