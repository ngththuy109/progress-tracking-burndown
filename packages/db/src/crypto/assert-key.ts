import type { PrismaClient } from '../client.js';
import { open, parseEncryptionKey, SecretBoxError } from './secret-box.js';

/**
 * Guard lúc boot (api + worker): nếu DB ĐÃ CÓ token Jira mã hóa mà
 * APP_ENCRYPTION_KEY thiếu hoặc không giải mã được, phải TỪ CHỐI khởi động —
 * cùng tinh thần với guard migration/env: thà không chạy còn hơn chạy nửa vời
 * (một số tenant sync được, số khác chết im lặng lúc 2h sáng).
 *
 * Chưa có token nào trong DB thì KHÔNG bắt buộc đặt khóa — hệ thống 1 site cũ
 * dùng env JIRA_* chạy tiếp mà không cần cấu hình thêm gì.
 */
export async function assertEncryptionKeyUsable(
  prisma: PrismaClient,
  rawKey: string | undefined,
): Promise<void> {
  const withToken = await prisma.project.findFirst({
    where: { jiraTokenEnc: { not: null } },
    select: { projectKey: true, jiraTokenEnc: true },
  });
  if (withToken === null) return; // chưa ai nhập token riêng → khóa chưa cần

  const key = parseEncryptionKey(rawKey); // ném SecretBoxError nếu thiếu/sai độ dài
  try {
    // jiraTokenEnc chắc chắn khác null theo điều kiện where ở trên.
    open(withToken.jiraTokenEnc as string, key);
  } catch (err) {
    if (err instanceof SecretBoxError) {
      throw new SecretBoxError(
        `APP_ENCRYPTION_KEY không giải mã được token của project "${withToken.projectKey}" — ` +
          'khóa hiện tại khác khóa đã dùng để mã hóa. Khôi phục đúng khóa cũ, hoặc nhập lại ' +
          'token Jira cho từng project ở màn hình quản trị.',
      );
    }
    throw err;
  }
}
