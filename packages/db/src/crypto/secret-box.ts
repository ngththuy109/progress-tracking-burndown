import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Mã hóa/giải mã Jira API token của từng tenant (`project.jira_token_enc`).
 *
 * VÌ SAO Ở @app/db: cả api lẫn worker đều cần giải mã token trước khi tạo
 * JiraClient, và cả hai đều phụ thuộc @app/db (không được import lẫn nhau).
 * KHÔNG đặt ở @app/shared — gói đó phải chạy được trong trình duyệt, cấm
 * `node:crypto`.
 *
 * Thiết kế:
 *   - AES-256-GCM (authenticated encryption): sửa 1 byte ciphertext là giải mã
 *     thất bại ngay, không trả về rác im lặng.
 *   - IV 12 byte ngẫu nhiên mỗi lần seal — cùng một token mã hóa 2 lần ra 2
 *     chuỗi khác nhau.
 *   - Định dạng chuỗi có tiền tố phiên bản `v1:<iv b64>:<tag b64>:<ct b64>`
 *     để sau này xoay thuật toán/khóa mà không phải đoán định dạng cũ.
 *   - Khóa 32 byte, đưa vào qua env APP_ENCRYPTION_KEY dạng base64.
 *
 * Nguyên tắc vận hành (cùng tinh thần C-9 "thà không chạy còn hơn chạy sai"):
 * boot phải fail-fast nếu DB đã có token mã hóa mà env thiếu/khác khóa — xem
 * assertEncryptionKeyUsable ở main.ts của api/worker.
 */

export const SECRET_BOX_VERSION = 'v1' as const;

/** Độ dài khóa bắt buộc (AES-256). */
export const SECRET_KEY_BYTES = 32;

const IV_BYTES = 12; // chuẩn GCM
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * Đọc khóa từ chuỗi base64 (giá trị env APP_ENCRYPTION_KEY).
 * Ném SecretBoxError nếu thiếu hoặc sai độ dài — thông điệp chứa luôn lệnh
 * sinh khóa đúng để người vận hành không phải đi tra.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === '') {
    throw new SecretBoxError(
      'APP_ENCRYPTION_KEY chưa được đặt. Sinh khóa mới bằng: ' +
        `node -e "console.log(require('crypto').randomBytes(${SECRET_KEY_BYTES}).toString('base64'))"`,
    );
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretBoxError(
      `APP_ENCRYPTION_KEY phải là ${SECRET_KEY_BYTES} byte ở dạng base64 ` +
        `(nhận được ${key.length} byte sau giải mã).`,
    );
  }
  return key;
}

/** Mã hóa plaintext → chuỗi "v1:<iv>:<tag>:<ct>" (các phần base64). */
export function seal(plaintext: string, key: Buffer): string {
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretBoxError(`Khóa phải đúng ${SECRET_KEY_BYTES} byte.`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_BOX_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

/**
 * Giải mã chuỗi do seal() tạo. Ném SecretBoxError khi định dạng lạ, phiên bản
 * không hỗ trợ, khóa sai, hoặc ciphertext bị sửa (GCM tag mismatch).
 */
export function open(sealed: string, key: Buffer): string {
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretBoxError(`Khóa phải đúng ${SECRET_KEY_BYTES} byte.`);
  }
  const parts = sealed.split(':');
  if (parts.length !== 4) {
    throw new SecretBoxError('Chuỗi token mã hóa sai định dạng (cần 4 phần "v1:iv:tag:ct").');
  }
  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  if (version !== SECRET_BOX_VERSION) {
    throw new SecretBoxError(`Phiên bản token mã hóa không hỗ trợ: "${version}".`);
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError('Chuỗi token mã hóa sai định dạng (IV/tag sai độ dài).');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    // Node ném lỗi chung chung khi tag mismatch — dịch thành thông điệp rõ ràng,
    // KHÔNG kèm ciphertext hay khóa vào message/log.
    throw new SecretBoxError('Giải mã thất bại: khóa sai hoặc dữ liệu đã bị sửa.');
  }
}
