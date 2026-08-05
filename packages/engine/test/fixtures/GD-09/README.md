# GD-09 · Hiệu năng

**Kịch bản.** 500 Sub-task chia đều cho 5 Phase, mỗi cái 1 giờ ước lượng và **10 bản ghi log giờ** — tổng **5000 worklog**. Toàn bộ giờ được log trong ngày 03/03.

**Điểm cần bắt.** Không phải một con số nghiệp vụ nào cả, mà là **thời gian chạy và bộ nhớ**. Ngưỡng đo nằm ở [`perf.test.ts`](../../golden/perf.test.ts).

**Dữ liệu cố ý đều tăm tắp.** Nhờ vậy kết quả mong đợi tính được bằng đúng hai phép nhân, không cần tính tay 500 dòng: ngày 02/03 chưa log gì nên còn nguyên 500 × 3600 = 1.800.000 giây; ngày 03/03 log đủ 10 × 360 = 3600 giây mỗi cái nên còn **0**.

**Nếu bộ này làm `pnpm test:engine` vượt 10 giây** thì tách sang script `test:perf` riêng, **đừng nới ngưỡng 10 giây** — ngưỡng đó tồn tại để lập trình viên thật sự chạy test thường xuyên.
