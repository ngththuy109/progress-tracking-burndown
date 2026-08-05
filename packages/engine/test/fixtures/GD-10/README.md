# GD-10 · Xoá trắng ước lượng còn lại

**Kịch bản.** Ngày 02/03 có người sửa tay ước lượng còn lại thành 5 giờ. Ngày 03/03 người khác **xoá trắng** ô đó (về `null`).

**Điểm cần bắt.** Từ 03/03, hệ thống phải **quay về quy tắc 3**: 8 giờ ước lượng ban đầu − 2 giờ đã log = 6 giờ. Không được giữ mãi con số 5 giờ của ngày hôm trước.

**Vì sao dễ sai.** Vòng lặp tìm giá trị mới nhất rất dễ viết thành `if (v !== null) latest = v` — bỏ qua đúng lần xoá trắng. Khi đó số 5 giờ bị đóng đinh vĩnh viễn (PRD E-05).

**Điều trông có vẻ lạ.** Khối lượng còn lại **tăng** từ 18000 lên 21600. Đó là đúng: người ta vừa rút lại lời khai của mình.
