---
id: T-34
title: Runbook vận hành và bàn giao
status: review
model: sonnet
effort: medium
depends_on: ["T-27", "T-29", "T-30", "T-31", "T-33"]
touches:
  - docs/RUNBOOK.md
  - docs/ONBOARDING.md
  - docs/UAT-CHECKLIST.md
  - tools/smoke/
  - tools/arch-tests/docs.test.ts
  - package.json
  - eslint.config.js
prd_refs: ["§9.1", "§9.4", "§10.2", "R-04", "R-07"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-34 · Runbook vận hành và bàn giao

## Mục tiêu
Người **không viết hệ thống này** vẫn vận hành được nó. Đây là card cuối của dự án; xong nó thì đội phát triển rút được.

## Ngữ cảnh cần biết

**Tiêu chí nghiệm thu GĐ 4 (PRD §9.1)** ghi rõ: *"runbook được DevOps ký nhận"*. Ký nhận nghĩa là **DevOps tự chạy thử được từng quy trình**, không phải đọc xong gật đầu.

Cách kiểm chứng duy nhất đáng tin: đưa runbook cho một người chưa từng đụng vào dự án và bảo họ làm theo. Chỗ nào họ phải hỏi thì chỗ đó runbook còn thiếu.

**Ba loại tài liệu, ba người đọc khác nhau:**

| Tài liệu | Ai đọc | Khi nào |
|---|---|---|
| `RUNBOOK.md` | DevOps trực | Lúc 2 giờ sáng, đang có sự cố |
| `ONBOARDING.md` | Lập trình viên mới | Ngày đầu tiên vào dự án |
| `UAT-CHECKLIST.md` | PM | Buổi nghiệm thu |

Viết chung một file là hỏng cả ba: người trực không có thời gian đọc phần giới thiệu kiến trúc.

## Phạm vi

**Trong:**
- `RUNBOOK.md` — xử lý sự cố, theo đúng 11 ngưỡng cảnh báo của T-27
- `ONBOARDING.md` — dựng môi trường từ máy trắng tới chạy được
- `UAT-CHECKLIST.md` — kịch bản nghiệm thu bám theo 15 user story
- `tools/smoke/` — script kiểm tra nhanh sau khi triển khai

**Ngoài:**
- Không viết code sản phẩm
- Không dựng hạ tầng triển khai (nằm ngoài phạm vi v1.0)

## Đầu vào đã có
- 11 ngưỡng cảnh báo từ **T-27**
- Dashboard giám sát từ **T-33**
- Ba màn hình từ **T-29**, **T-30**, **T-31**
- 15 user story trong PRD
- Bảng rủi ro R-01 → R-11 trong PRD §10.2

## Việc phải làm

1. **`RUNBOOK.md`** — mỗi cảnh báo một mục, cùng một khuôn:
   ```
   ## [P1] Job đêm chưa chạy xong sau 4 tiếng

   Triệu chứng: ...
   Ảnh hưởng: biểu đồ của mọi Epic dừng ở số liệu hôm qua
   Kiểm tra ngay: (3 lệnh cụ thể, dán vào chạy được)
   Ba nguyên nhân thường gặp: ...
   Cách xử lý: ...
   Khi nào phải gọi Tech Lead: ...
   ```
   Đủ **11 mục**, đúng 11 ngưỡng của T-27. Không thiếu cái nào.

2. Bốn quy trình vận hành thường dùng, mỗi cái có lệnh cụ thể:
   - Dựng lại lịch sử một Epic
   - Đổi token Jira (kể cả khi token cũ đã hết hạn)
   - Tắt khẩn cấp việc gọi Jira (R-04)
   - Quay lại một version cấu hình

3. **`ONBOARDING.md`** — từ máy trắng tới `pnpm dev` chạy được: cài gì, chạy lệnh nào, seed dữ liệu ra sao, chạy test thế nào. Kèm sơ đồ ranh giới bốn package và **lý do** của hai hàng rào lint.

4. **`UAT-CHECKLIST.md`** — mỗi user story một dòng, ghi rõ *thao tác gì* và *thấy gì thì coi là đạt*. PM tự tick được, không cần dev ngồi cạnh.

5. `tools/smoke/` — script chạy sau mỗi lần triển khai: gọi thử vài endpoint, kiểm tra job đêm đã đăng ký, kiểm tra kết nối Jira. Chạy dưới 30 giây, thoát khác 0 khi có gì sai.

6. **Mục "khi nào KHÔNG nên tự sửa"** trong runbook: các tình huống mà thao tác vội sẽ làm hỏng dữ liệu — ví dụ chạy lại backfill trong lúc job đêm đang chạy.

7. Bảng tra nhanh *"số liệu trông sai — kiểm tra gì trước"*, nối thẳng sang tính năng giải thích số liệu của T-25 (giảm R-07).

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-9** — mọi thông báo và tài liệu bằng tiếng Việt, nói **cả điều sai lẫn cách khắc phục**.
- Văn phong: **dễ hiểu, không dùng thuật ngữ nặng**. Giữ từ tiếng Anh nào thì giải thích ngắn ngay lần đầu.

## Checklist đầu ra
- [ ] Đủ **11 mục** trong runbook, khớp 11 ngưỡng của T-27
- [ ] Một người chưa từng đụng dự án dựng được môi trường **chỉ bằng `ONBOARDING.md`**
- [ ] `tools/smoke/` chạy dưới 30 giây và thoát khác 0 khi có lỗi
- [ ] `UAT-CHECKLIST.md` phủ đủ 15 user story
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Kiểm bằng máy:**
1. `runbook có đúng 11 mục, mã cảnh báo khớp với danh sách của T-27` — test quét file
2. `mọi user story US-01 → US-15 đều xuất hiện trong UAT-CHECKLIST` — test quét file
3. `script smoke thoát khác 0 khi API không phản hồi`
4. `mọi lệnh trong runbook đều là lệnh có thật trong package.json` — test đối chiếu

**Kiểm bằng người:**
5. Một người chưa từng đụng dự án dựng môi trường theo `ONBOARDING.md`, ghi lại **mọi chỗ phải hỏi** — mỗi chỗ hỏi là một lỗ hổng phải vá.

## Định nghĩa "xong"
DevOps đọc runbook, tự xử lý được một cảnh báo P1 giả lập mà không gọi ai. PM chạy hết UAT checklist và ký nhận.

## Cạm bẫy đã biết
- **Runbook viết chung chung là runbook vô dụng.** *"Kiểm tra log"* không giúp được ai lúc 2 giờ sáng. Phải là lệnh cụ thể, dán vào chạy được, kèm ví dụ đầu ra bình thường trông thế nào.
- **Tài liệu không được kiểm bằng máy sẽ mục trong ba tháng.** Bốn test quét file ở trên tồn tại vì lý do đó: đổi tên lệnh trong `package.json` mà quên sửa runbook thì CI đỏ.
- **Đừng viết onboarding từ trí nhớ.** Máy của người viết đã cài sẵn đủ thứ. Cách duy nhất đáng tin là làm theo chính tài liệu của mình trên một môi trường sạch.
- **Mục "khi nào KHÔNG nên tự sửa" quan trọng ngang phần hướng dẫn sửa.** Người trực lúc nửa đêm có xu hướng thử mọi thứ; một dòng "đừng chạy lại backfill khi job đêm đang chạy" tiết kiệm cả một ngày dọn dữ liệu.
- **UAT checklist mà cần dev ngồi cạnh giải thích thì chưa xong.** Mỗi dòng phải nói rõ thấy gì thì coi là đạt.
- **Đây là card cuối nên rất dễ bị làm qua loa cho xong dự án.** Nhưng nó chính là thứ quyết định hệ thống sống được bao lâu sau khi đội phát triển rút.

## Đã làm gì

**10 test kiểm tài liệu bằng máy xanh.** Bốn tài liệu và hai script vận hành.

### Tài liệu được kiểm bằng máy, không chỉ bằng mắt

Đây là phần quan trọng nhất của card. Tài liệu không có test sẽ mục trong ba tháng:

| Test | Chặn được gì |
|---|---|
| Runbook có **đủ 11 mục**, mỗi mã cảnh báo một tiêu đề riêng | Thêm ngưỡng thứ 12 mà quên viết mục xử lý |
| **Mọi lệnh `pnpm` trong runbook có thật trong `package.json`** | Đổi tên script mà quên sửa runbook — người trực lúc 2 giờ sáng dán vào một lệnh không tồn tại |
| UAT phủ **đủ 15 user story** | Bỏ sót một tính năng khỏi buổi nghiệm thu |
| Onboarding nói đúng cổng dev (5180) và cổng E2E (5199) | Người mới mở nhầm 5173 và thấy app của dự án khác |

Test đầu tiên đọc thẳng `ALERT_CODE` từ `@app/shared`, nên nó **không thể lệch** với mã nguồn.

### Ba tài liệu, ba người đọc, ba giọng khác nhau

| Tài liệu | Ai đọc | Viết kiểu gì |
|---|---|---|
| `RUNBOOK.md` | người trực, có thể 2 giờ sáng | tra theo mã cảnh báo, lệnh dán vào chạy được ngay, có ví dụ đầu ra bình thường |
| `ONBOARDING.md` | lập trình viên mới | từ máy trắng tới `pnpm dev`, kèm **lý do** của hai hàng rào lint |
| `UAT-CHECKLIST.md` | PM | 35 dòng, mỗi dòng ghi *thao tác* và *đạt khi thấy gì* |

Viết chung một file là hỏng cả ba: người trực không có thời gian đọc phần giới thiệu kiến trúc.

### Mục "khi nào KHÔNG nên tự sửa" đứng ngay đầu runbook

Ba việc làm hỏng dữ liệu: chạy lại backfill khi job đêm đang chạy, sửa thẳng `daily_snapshot` bằng SQL, xoá Epic để "làm sạch". Người trực lúc nửa đêm có xu hướng thử mọi thứ, và một dòng cảnh báo đúng chỗ tiết kiệm cả ngày dọn dữ liệu.

Kèm câu: *"Một cuộc gọi lúc 2 giờ sáng rẻ hơn một ngày dọn dữ liệu."*

### Bảng tra "số liệu trông sai" nối thẳng vào tính năng giải thích

Năm bước, bước hai là *"xem cột Quy tắc — có dòng nào ghi Quy tắc 2 không?"*. Đây là câu trả lời cho rủi ro **R-07** (PM không tin số liệu): không tranh luận, mở bảng giải thích ra.

### Hai script vận hành, cả hai thoát khác 0 khi có vấn đề

- `pnpm smoke` — 5 mục kiểm, dưới 30 giây. Script chỉ in ra rồi luôn thoát 0 thì không chặn được lần triển khai hỏng nào.
- `pnpm reconcile -- --epic=KEY` — **mặc định chỉ in kết quả**; phải thêm `--fix` mới tự chạy bù. Đúng như card yêu cầu, và lý do được ghi ngay trong file.

### Kèm theo

Đã thêm khối cấu hình eslint cho `tools/smoke/**/*.mjs`: script chạy thẳng bằng Node nên dùng `process`, `fetch`, `console` — những biến toàn cục mà cấu hình mặc định không biết.

### Chưa làm được ở đây

Test số 5 của card — *"một người chưa từng đụng dự án dựng môi trường theo ONBOARDING.md"* — cần một người thật và một môi trường sạch. Bốn test quét file ở trên chỉ chặn được tài liệu **mục**, không chặn được tài liệu **thiếu**. Đây là việc phải làm trong buổi bàn giao.
