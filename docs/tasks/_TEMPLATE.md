---
id: T-NN
title: <câu mệnh lệnh ngắn>
status: todo            # todo | in_progress | review | done | blocked
model: sonnet           # sonnet | opus | codex
effort: medium          # low | medium | high
depends_on: []          # ["T-02"]
touches:                # file/thư mục sẽ đụng — phát hiện xung đột khi chạy song song
  - src/worker/...
prd_refs: []            # ["§4", "§11"] — mục PRD là nguồn sự thật cho task này
owner: null             # agent id khi đang chạy
started_at: null
finished_at: null
---

# T-NN · <title>

## Mục tiêu
1–3 câu. Task này làm **được việc gì** cho người dùng hoặc cho task sau.
Không mô tả cách làm ở đây.

## Ngữ cảnh cần biết
Chỉ những gì agent không tự suy ra được từ code: quyết định đã chốt, lý do
nghiệp vụ. Trích thẳng đoạn PRD liên quan thay vì bảo "đọc PRD".

## Phạm vi
**Trong:** danh sách cụ thể.

**Ngoài:** ghi rõ thứ dễ bị làm lố.

## Đầu vào đã có
File/hàm/bảng đã tồn tại mà task này dùng lại. Ghi đường dẫn thật.
Nếu phụ thuộc task khác, ghi rõ nó để lại cái gì.

## Việc phải làm
Các bước, đủ chi tiết để không phải đoán, đủ thoáng để không gò cách viết.

## Quy ước bắt buộc
Copy từ `docs/tasks/CONVENTIONS.md` những mục liên quan. Đây là chỗ ngăn agent
tự chế lại convention đã chốt.

## Checklist đầu ra
- [ ] Typecheck: `npm run typecheck` xanh
- [ ] Test API: `npm test -- <file>` xanh
- [ ] Test E2E: `npm run e2e -- <spec>` xanh (bắt buộc nếu task có UI)
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at` trong frontmatter card này
- [ ] Ghi 3–5 dòng "Đã làm gì" vào cuối card

## Test phải viết
Liệt kê **tên từng test case**, không chỉ "viết test". Mỗi case khẳng định một
hành vi nghiệp vụ, không phải một dòng code.

## Định nghĩa "xong"
Một câu kiểm chứng được.

## Cạm bẫy đã biết
Lỗi mà người trước đã vấp, hoặc lỗi im lặng mà test dễ bỏ sót.

## Đã làm gì
(agent điền khi xong)
