import type { IssueDrift, IssueTotals, ReconcileResult } from '@app/shared';

/**
 * So tổng của database với tổng của Jira — PRD E-18.
 *
 * HÀM THUẦN, nằm ở engine nên test được mà không cần Jira lẫn PostgreSQL.
 *
 * BA LOẠI LỆCH ĐƯỢC PHÂN BIỆT RÕ, vì chúng có nguyên nhân hoàn toàn khác nhau:
 *
 *   • `MISSING_IN_DB`   — Jira có, DB không. Đồng bộ tăng dần bỏ sót.
 *   • `MISSING_IN_JIRA` — DB có, Jira không. Issue bị xoá hoặc chuyển Epic mà
 *                          chưa được đánh dấu `removed_at`.
 *   • `VALUE_DIFFERS`   — cả hai có, số khác nhau. Worklog bị xoá hoặc sửa.
 *
 * Gộp cả ba thành một con số duy nhất sẽ làm mất đúng thông tin cần nhất để
 * chẩn đoán.
 */
export function compareTotals(
  db: readonly IssueTotals[],
  jira: readonly IssueTotals[],
): ReconcileResult {
  const dbByKey = new Map(db.map((r) => [r.issueKey, r]));
  const jiraByKey = new Map(jira.map((r) => [r.issueKey, r]));

  const perIssue: IssueDrift[] = [];

  for (const [key, j] of jiraByKey) {
    const d = dbByKey.get(key);
    if (d === undefined) {
      perIssue.push({ issueKey: key, kind: 'MISSING_IN_DB', dbS: null, jiraS: j.timeSpentS });
      continue;
    }
    // So bằng GIÂY. Đổi sang giờ rồi mới so sẽ sinh lệch giả do làm tròn: 3599
    // và 3600 giây đều thành "1 giờ" ở chỗ này nhưng khác nhau ở chỗ khác (C-2).
    if (d.timeSpentS !== j.timeSpentS) {
      perIssue.push({ issueKey: key, kind: 'VALUE_DIFFERS', dbS: d.timeSpentS, jiraS: j.timeSpentS });
    }
  }

  for (const [key, d] of dbByKey) {
    if (!jiraByKey.has(key)) {
      perIssue.push({ issueKey: key, kind: 'MISSING_IN_JIRA', dbS: d.timeSpentS, jiraS: null });
    }
  }

  const totalDbS = sum(db);
  const totalJiraS = sum(jira);

  return {
    // Tỉ lệ tính trên TỔNG, không phải trung bình chênh lệch từng issue: một
    // Epic có 500 Sub-task mà lệch 10 giờ ở một cái thì tổng thể vẫn ổn, còn
    // trung bình từng issue sẽ thổi phồng con số đó lên.
    driftRatio: totalJiraS === 0 ? 0 : Math.abs(totalDbS - totalJiraS) / totalJiraS,
    totalDbS,
    totalJiraS,
    // Thứ tự ổn định để hai lần chạy cho kết quả giống nhau (C-6).
    perIssue: perIssue.sort(
      (a, b) => a.issueKey.localeCompare(b.issueKey) || a.kind.localeCompare(b.kind),
    ),
  };
}

function sum(rows: readonly IssueTotals[]): number {
  return rows.reduce((acc, r) => acc + r.timeSpentS, 0);
}
