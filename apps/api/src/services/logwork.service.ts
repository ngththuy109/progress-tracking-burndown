import {
  LOGWORK_OVER_LIMIT_HOURS,
  LOGWORK_UNDER_LIMIT_HOURS,
  logworkCellFlag,
  type LogworkByPicResponse,
  type LogworkByPicRow,
  type LogworkCellTicket,
  type LogworkMember,
  type LogworkResponse,
  type LogworkTicket,
  type StatusCategory,
} from '@app/shared';

/**
 * Dựng báo cáo LOG WORK theo member — HÀM THUẦN.
 *
 * Không chạm database, không đọc đồng hồ, không luxon: nhận đủ dữ liệu đã nạp
 * (Sub-task + participant, tổng worklog theo cửa sổ thời gian, các bản exempt)
 * cùng vài con số đã tính sẵn ở tầng route (số ngày công đã prorate + giờ/ngày
 * cho từng Epic), rồi trả về `LogworkResponse`. Nhờ thuần nên test được bằng
 * mảng thường, không cần Postgres và không phụ thuộc "hôm nay là ngày nào".
 */

const SECONDS_PER_HOUR = 3600;
/** Nhiễu số thực khi so giờ log với giờ kỳ vọng. */
const EPSILON = 1e-9;

const memberAuthorKey = (issueKey: string, accountId: string): string => `${issueKey} ${accountId}`;

export interface LogworkParticipant {
  readonly accountId: string;
  readonly displayName: string | null;
}

/** Một Sub-task ĐANG MỞ (chưa `done`, chưa gỡ khỏi Epic) kèm participant. */
export interface LoadedLogworkSubtask {
  readonly issueKey: string;
  readonly epicKey: string;
  readonly summary: string;
  readonly parentKey: string | null;
  readonly phaseCode: string;
  readonly statusCategory: StatusCategory;
  readonly originalEstimateSeconds: number;
  readonly participants: readonly LogworkParticipant[];
}

/** Tổng giây log theo (issue, tác giả) trong cửa sổ; `authorId` null = worklog không rõ tác giả. */
export interface WorklogSumRow {
  readonly issueKey: string;
  readonly authorId: string | null;
  readonly seconds: number;
}

/** Bản "PM đã verify — thôi theo dõi" cho một cặp (member, ticket). */
export interface LogworkExemptionRow {
  readonly accountId: string;
  readonly issueKey: string;
  readonly exemptedBy: string;
  readonly exemptedAt: string;
}

/** Thông tin từng Epic thấy được — route tính sẵn để service chỉ việc nhân. */
export interface EpicCapacity {
  readonly projectKey: string;
  /** Số ngày công trong kỳ, ĐÃ prorate theo ngày đã trôi qua (route tính theo múi giờ Epic). */
  readonly effectiveWorkdays: number;
  /** Giờ/ngày: override theo project → giờ/ngày của lịch → mặc định 8 (route đã chọn). */
  readonly hoursPerDay: number;
}

export interface BuildLogworkInput {
  readonly from: string;
  readonly to: string;
  /** Metadata mọi Epic thấy được, khoá theo `epicKey`. */
  readonly perEpic: Readonly<Record<string, EpicCapacity>>;
  readonly partialPeriod: boolean;
  readonly visibleEpicCount: number;
  readonly warnings: readonly string[];
  /** Có gộp cả người CÓ log giờ nhưng không in-charge ticket mở nào không. */
  readonly includeUnassignedAuthors: boolean;
  readonly subtasks: readonly LoadedLogworkSubtask[];
  readonly worklogSums: readonly WorklogSumRow[];
  readonly exemptions: readonly LogworkExemptionRow[];
}

interface MemberAccum {
  readonly accountId: string;
  readonly tickets: LogworkTicket[];
  /** epicKey → số ticket in-charge đang mở, để chọn Epic "chính" tính capacity. */
  readonly epicOpenCount: Map<string, number>;
  exemptedCount: number;
}

export function buildLogworkReport(input: BuildLogworkInput): LogworkResponse {
  const {
    from,
    to,
    perEpic,
    partialPeriod,
    visibleEpicCount,
    warnings,
    includeUnassignedAuthors,
    subtasks,
    worklogSums,
    exemptions,
  } = input;

  // 1) Gom worklog: theo (issue, tác giả), theo issue (mọi tác giả kể cả null),
  //    và theo tác giả (bỏ null — worklog không rõ tác giả không thuộc về ai).
  const byIssueAuthor = new Map<string, number>();
  const perIssueTotal = new Map<string, number>();
  const perAuthorTotal = new Map<string, number>();
  for (const w of worklogSums) {
    perIssueTotal.set(w.issueKey, (perIssueTotal.get(w.issueKey) ?? 0) + w.seconds);
    if (w.authorId !== null) {
      const k = memberAuthorKey(w.issueKey, w.authorId);
      byIssueAuthor.set(k, (byIssueAuthor.get(k) ?? 0) + w.seconds);
      perAuthorTotal.set(w.authorId, (perAuthorTotal.get(w.authorId) ?? 0) + w.seconds);
    }
  }

  // 2) Index exemption theo (issue, member).
  const exemptionByKey = new Map<string, LogworkExemptionRow>();
  for (const e of exemptions) exemptionByKey.set(memberAuthorKey(e.issueKey, e.accountId), e);

  // 3) Tên hiển thị: bản KHÔNG rỗng ĐẦU TIÊN thấy được cho mỗi accountId thắng.
  //    (Cùng một người có thể xuất hiện ở nhiều Epic, chỗ có tên chỗ chỉ có id.)
  const nameOf = new Map<string, string | null>();
  for (const s of subtasks) {
    for (const p of s.participants) {
      const cur = nameOf.get(p.accountId);
      if (cur === undefined || (cur === null && p.displayName !== null)) {
        nameOf.set(p.accountId, p.displayName);
      }
    }
  }

  // 4) Với mỗi Sub-task mở: bỏ trùng participant trong ticket, phát một dòng
  //    ticket cho từng member đang in-charge.
  const members = new Map<string, MemberAccum>();
  let hasParticipantData = false;

  for (const s of subtasks) {
    const seenInTicket = new Set<string>();
    const epicMeta = perEpic[s.epicKey];
    for (const p of s.participants) {
      if (seenInTicket.has(p.accountId)) continue;
      seenInTicket.add(p.accountId);
      hasParticipantData = true;

      const memberSeconds = byIssueAuthor.get(memberAuthorKey(s.issueKey, p.accountId)) ?? 0;
      const totalSeconds = perIssueTotal.get(s.issueKey) ?? 0;
      const exemption = exemptionByKey.get(memberAuthorKey(s.issueKey, p.accountId)) ?? null;
      const exempted = exemption !== null;

      const ticket: LogworkTicket = {
        issueKey: s.issueKey,
        epicKey: s.epicKey,
        projectKey: epicMeta?.projectKey ?? '',
        summary: s.summary,
        parentKey: s.parentKey,
        phaseCode: s.phaseCode,
        statusCategory: s.statusCategory,
        originalEstimateHours: s.originalEstimateSeconds / SECONDS_PER_HOUR,
        memberLoggedHours: memberSeconds / SECONDS_PER_HOUR,
        totalLoggedHours: totalSeconds / SECONDS_PER_HOUR,
        // "Chưa log" = CHÍNH member đó chưa log; ticket đã exempt thì thôi gắn cờ.
        notLogged: memberSeconds === 0 && !exempted,
        exempted,
        exemptedBy: exemption?.exemptedBy ?? null,
        exemptedAt: exemption?.exemptedAt ?? null,
      };

      const m = ensureMember(members, p.accountId);
      m.tickets.push(ticket);
      m.epicOpenCount.set(s.epicKey, (m.epicOpenCount.get(s.epicKey) ?? 0) + 1);
      if (exempted) m.exemptedCount += 1;
    }
  }

  // 5) Người CÓ log giờ nhưng không in-charge ticket mở nào — hiện để công sức
  //    của họ không "tàng hình", nhưng danh sách ticket rỗng.
  if (includeUnassignedAuthors) {
    for (const accountId of perAuthorTotal.keys()) {
      if (!members.has(accountId)) ensureMember(members, accountId);
    }
  }

  // 6) Lắp từng member.
  const out: LogworkMember[] = [];
  for (const m of members.values()) {
    m.tickets.sort((a, b) => a.issueKey.localeCompare(b.issueKey));

    const totalLoggedHours = (perAuthorTotal.get(m.accountId) ?? 0) / SECONDS_PER_HOUR;
    const notLoggedCount = m.tickets.reduce((acc, t) => acc + (t.notLogged ? 1 : 0), 0);

    const primaryEpicKey = pickPrimaryEpic(m.epicOpenCount);
    const cap = primaryEpicKey !== null ? perEpic[primaryEpicKey] : undefined;
    const expectedHours = cap ? cap.effectiveWorkdays * cap.hoursPerDay : 0;
    const deficitHours = Math.max(0, expectedHours - totalLoggedHours);
    const behind = expectedHours > 0 && totalLoggedHours + EPSILON < expectedHours;

    out.push({
      accountId: m.accountId,
      displayName: nameOf.get(m.accountId) ?? null,
      totalLoggedHours,
      hasOpenAssignments: m.tickets.length > 0,
      tickets: m.tickets,
      notLoggedCount,
      exemptedCount: m.exemptedCount,
      primaryEpicKey,
      expectedHours,
      deficitHours,
      behind,
    });
  }

  // 7) Sắp member: rủi ro lên đầu, ổn định cho golden test.
  out.sort(
    (a, b) =>
      b.notLoggedCount - a.notLoggedCount ||
      a.totalLoggedHours - b.totalLoggedHours ||
      nameKey(a).localeCompare(nameKey(b), 'vi'),
  );

  return {
    from,
    to,
    members: out,
    totalMembers: out.length,
    totalNotLogged: out.reduce((acc, m) => acc + m.notLoggedCount, 0),
    visibleEpicCount,
    hasParticipantData,
    partialPeriod,
    warnings,
  };
}

function ensureMember(map: Map<string, MemberAccum>, accountId: string): MemberAccum {
  let m = map.get(accountId);
  if (m === undefined) {
    m = { accountId, tickets: [], epicOpenCount: new Map(), exemptedCount: 0 };
    map.set(accountId, m);
  }
  return m;
}

/**
 * Epic "chính" của member = Epic họ in-charge NHIỀU ticket mở nhất; hoà thì lấy
 * `epicKey` nhỏ hơn cho ổn định. Đơn giản hoá có chủ đích: một người trải trên
 * nhiều vùng/lịch chỉ lấy kỳ vọng của một Epic (ghi rõ ở plan, gỡ được).
 * `null` khi member không in-charge Epic nào (chỉ có log giờ).
 */
function pickPrimaryEpic(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const [epicKey, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && epicKey < best)) {
      best = epicKey;
      bestCount = count;
    }
  }
  return best;
}

const nameKey = (m: LogworkMember): string => m.displayName ?? m.accountId;

// ===========================================================================
// Báo cáo LƯỚI: PIC × NGÀY — HÀM THUẦN.
//
// Nhận các dòng worklog ĐÃ gộp theo (tác giả, NGÀY ĐỊA PHƯƠNG) cùng danh sách
// cột ngày và bản đồ tên (route tính sẵn — việc xếp worklog vào đúng ngày địa
// phương do tầng đọc lo, tại đây không đụng múi giờ/đồng hồ), rồi bày thành ma
// trận. Thuần nên test bằng mảng thường, không cần Postgres.
// ===========================================================================

/** Một dòng worklog đã gộp theo (tác giả, ngày địa phương, TICKET) trong cửa sổ. */
export interface WorklogDailyRow {
  /** `null` = worklog không rõ tác giả — không quy được cho PIC nào, bỏ qua. */
  readonly authorId: string | null;
  /** Ngày ĐỊA PHƯƠNG 'YYYY-MM-DD' (theo múi giờ tham chiếu) worklog thuộc về. */
  readonly localDate: string;
  /** Ticket đã log — để bày danh sách ticket theo từng ô ngày (rê chuột mở link). */
  readonly issueKey: string;
  /** Tiêu đề ticket (LEFT JOIN); `null` nếu issue không còn trong sổ (worklog mồ côi). */
  readonly summary: string | null;
  readonly seconds: number;
}

export interface BuildLogworkByPicInput {
  readonly from: string;
  readonly to: string;
  /** Các CỘT: mọi ngày lịch trong `[from, to]`, tăng dần (route dựng bằng engine). */
  readonly dates: readonly string[];
  /** Mỗi cột có phải NGÀY LÀM VIỆC không (song song `dates`) — route tính từ lịch tham chiếu. */
  readonly workingDays: readonly boolean[];
  /** HÔM NAY ở múi giờ tham chiếu — ngày `< today` là đã qua (để đánh dấu `missing`). */
  readonly today: string;
  readonly dailyRows: readonly WorklogDailyRow[];
  /** accountId → tên hiển thị (từ participant JSON); thiếu thì web hiện accountId. */
  readonly names: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
}

interface PicAccum {
  /** Giờ theo chỉ số cột (song song với `dates`). */
  readonly hoursByDate: number[];
  /** Theo cột: issueKey → (giây, tiêu đề). Gộp nhiều dòng log cùng ticket cùng ngày. */
  readonly ticketsByDate: Array<Map<string, { seconds: number; summary: string | null }>>;
}

export function buildLogworkByPicReport(input: BuildLogworkByPicInput): LogworkByPicResponse {
  const { from, to, dates, workingDays, today, dailyRows, names, warnings } = input;

  // Vị trí cột của mỗi ngày; worklog rơi ngoài khoảng cột thì bỏ (phòng thủ —
  // cửa sổ đọc vốn đã kẹp trong [from, to] nên bình thường không xảy ra).
  const colOf = new Map<string, number>();
  dates.forEach((d, i) => colOf.set(d, i));

  const byPic = new Map<string, PicAccum>();
  for (const r of dailyRows) {
    if (r.authorId === null) continue;
    const col = colOf.get(r.localDate);
    if (col === undefined) continue;
    let acc = byPic.get(r.authorId);
    if (acc === undefined) {
      acc = {
        hoursByDate: new Array<number>(dates.length).fill(0),
        ticketsByDate: Array.from({ length: dates.length }, () => new Map()),
      };
      byPic.set(r.authorId, acc);
    }
    acc.hoursByDate[col] = (acc.hoursByDate[col] ?? 0) + r.seconds / SECONDS_PER_HOUR;
    // Gộp giờ theo ticket trong ô (một người có thể có nhiều lần log cùng ticket
    // trong ngày); giữ tiêu đề KHÔNG rỗng đầu tiên thấy được.
    const cellTickets = acc.ticketsByDate[col];
    if (cellTickets !== undefined) {
      const prev = cellTickets.get(r.issueKey);
      if (prev === undefined) cellTickets.set(r.issueKey, { seconds: r.seconds, summary: r.summary });
      else {
        prev.seconds += r.seconds;
        if (prev.summary === null && r.summary !== null) prev.summary = r.summary;
      }
    }
  }

  const rows: LogworkByPicRow[] = [];
  const dailyTotalsRaw = new Array<number>(dates.length).fill(0);
  let grandRaw = 0;
  for (const [accountId, acc] of byPic) {
    let warnCount = 0;
    let missingCount = 0;
    let offdayCount = 0;
    let rowRaw = 0;
    const ticketsByDate: LogworkCellTicket[][] = [];
    // Làm tròn TỪNG ô về 2 số lẻ để con số HIỂN THỊ đúng bằng con số quyết định
    // tô cảnh báo (giây / 3600 có thể ra số lẻ dài). Tổng cộng từ ô đã tròn nên
    // "tổng hàng = tổng các ô nhìn thấy".
    const cells = acc.hoursByDate.map((h, i) => {
      const r = round2(h);
      dailyTotalsRaw[i] = (dailyTotalsRaw[i] ?? 0) + r;
      rowRaw += r;
      // Cùng NGUỒN CHÂN LÝ với web: ngày làm việc? đã qua? → dấu của ô.
      const flag = logworkCellFlag(r, workingDays[i] ?? true, (dates[i] ?? '') < today);
      if (flag === 'under' || flag === 'over') warnCount += 1;
      else if (flag === 'missing') missingCount += 1;
      else if (flag === 'offday') offdayCount += 1;

      // Danh sách ticket của ô: giờ giảm dần rồi mã tăng dần (đóng góp lớn lên trước).
      const cellTickets = acc.ticketsByDate[i];
      const list: LogworkCellTicket[] =
        cellTickets === undefined
          ? []
          : [...cellTickets.entries()].map(([issueKey, v]) => ({
              issueKey,
              summary: v.summary,
              hours: round2(v.seconds / SECONDS_PER_HOUR),
            }));
      list.sort((a, b) => b.hours - a.hours || a.issueKey.localeCompare(b.issueKey));
      ticketsByDate.push(list);
      return r;
    });
    grandRaw += rowRaw;
    rows.push({
      accountId,
      displayName: names.get(accountId) ?? null,
      hoursByDate: cells,
      ticketsByDate,
      totalHours: round2(rowRaw),
      warnCount,
      missingCount,
      offdayCount,
    });
  }

  // Xếp theo tên (rồi accountId) cho ổn định — bảng đọc như một danh sách tên.
  rows.sort((a, b) => byPicNameKey(a).localeCompare(byPicNameKey(b), 'vi'));

  return {
    from,
    to,
    dates: [...dates],
    workingDays: [...workingDays],
    today,
    rows,
    dailyTotals: dailyTotalsRaw.map(round2),
    grandTotal: round2(grandRaw),
    underLimitHours: LOGWORK_UNDER_LIMIT_HOURS,
    overLimitHours: LOGWORK_OVER_LIMIT_HOURS,
    warnings: [...warnings],
  };
}

const byPicNameKey = (r: LogworkByPicRow): string => r.displayName ?? r.accountId;

/** Làm tròn 2 số lẻ, dọn nhiễu số thực (`8.000000001` → `8`). */
const round2 = (h: number): number => Math.round(h * 100) / 100;
