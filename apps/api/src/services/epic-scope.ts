import { ApiError } from './phase-config.service.js';

/**
 * Neo Epic vào đúng tenant — dùng CHUNG cho mọi route dạng
 * `/api/projects/:projectKey/epics/:epicKey/...`.
 *
 * `requireProject` mới chỉ chứng minh "người gọi được vào dự án X"; còn phải
 * chứng minh "Epic này THUỘC dự án X". Thiếu bước hai thì PM của dự án B vẫn mở
 * được biểu đồ của dự án A bằng cách ghép key Epic của A vào URL dự án B.
 *
 * Sai tenant trả về ĐÚNG lỗi 404 EPIC_NOT_FOUND như Epic không tồn tại — cùng
 * luật "404 thay vì 403" của project-scope: không xác nhận cho người ngoài rằng
 * một Epic có thật.
 */
export function epicNotFound(epicKey: string): ApiError {
  return new ApiError(
    404,
    'EPIC_NOT_FOUND',
    `Epic ${epicKey} is not tracked in this project. Add it on the Epics screen first.`,
  );
}

/**
 * Tra Epic qua cổng `load` sẵn có của từng nhóm route, rồi kiểm nó thuộc đúng
 * `projectKey` của URL. Trả về metadata để handler khỏi tra lần hai.
 */
export async function resolveEpicInProject<T extends { projectKey: string }>(
  load: (epicKey: string) => Promise<T | null>,
  epicKey: string,
  projectKey: string,
): Promise<T> {
  const meta = await load(epicKey);
  if (meta === null || meta.projectKey !== projectKey) throw epicNotFound(epicKey);
  return meta;
}
