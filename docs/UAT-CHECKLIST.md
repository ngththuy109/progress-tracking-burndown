# Checklist nghiệm thu (UAT)

**Ai dùng file này:** PM, trong buổi nghiệm thu.

**Cách dùng:** làm theo cột *Thao tác*, so với cột *Đạt khi thấy*. Không cần dev ngồi cạnh giải thích — chỗ nào phải hỏi thì chỗ đó tài liệu còn thiếu, ghi lại để đội sửa.

**Chuẩn bị:** một Epic thật đã đồng bộ xong, có ít nhất 2 Phase và 10 Sub-task.

---

## Sổ đăng ký Epic

| # | User story | Thao tác | Đạt khi thấy | ☐ |
|---|---|---|---|---|
| 1 | **US-01** Thêm Epic vào hệ thống | Mở *Epics*, dán 3 mã Epic (2 đúng, 1 sai), bấm **Check** | Bảng hiện rõ 2 cái *can add*, 1 cái *cannot add* kèm **lý do đọc được** (không phải mã lỗi). Chưa có gì được thêm | ☐ |
| 2 | **US-01** Biết trước chi phí | Nhìn dòng chữ trước nút Xác nhận | Ghi rõ *"sẽ thêm N Epic, mất khoảng M phút"* và *"trong lúc đó chưa có biểu đồ"* | ☐ |
| 3 | **US-01** Thêm thật | Bấm **Add N Epics** | Epic xuất hiện trong bảng với trạng thái *đang dựng lịch sử* | ☐ |
| 4 | **US-02** Tạm dừng ≠ bỏ theo dõi | Đọc nhãn hai nút ở dòng một Epic | Nút ghi rõ *Pause (keep data)* và *Untrack (delete data)* | ☐ |
| 5 | **US-02** Tạm dừng rồi bật lại | Bấm **Pause (keep data)**, chờ, bấm **Resume** | Dữ liệu cũ còn nguyên, biểu đồ không mất gì | ☐ |
| 6 | **US-02** Bỏ theo dõi có rào chắn | Bấm **Untrack (delete data)** | Hộp thoại bắt **gõ lại mã Epic**; nút Xoá chỉ mở khi gõ đúng | ☐ |
| 7 | **US-10** Sub-task thiếu ngày | Bấm vào số ở cột **Missing dates** | Hiện danh sách từng Sub-task, ghi rõ thiếu ngày bắt đầu hay ngày kết thúc | ☐ |
| 7b | **US-02** Đồng bộ lại có ba mức | Bấm **Resync** ở dòng một Epic | Hộp thoại cho chọn *Quick* / *Full* / *A specific date range*; mặc định là **Quick** | ☐ |
| 7c | **US-02** Mức đắt nói rõ cái giá | Chọn mức *Full* | Hiện cảnh báo mức này chiếm **hạn mức gọi Jira của cả hệ thống** | ☐ |
| 7d | **US-02** Dải ngày ngược bị chặn | Chọn *A specific date range*, đặt ngày đầu **sau** ngày cuối | Nút **Resync** mờ đi, kèm câu giải thích đọc được | ☐ |

## Cấu hình nhận diện Phase

| # | User story | Thao tác | Đạt khi thấy | ☐ |
|---|---|---|---|---|
| 8 | **US-07** Xem thử trước khi lưu | Mở *Phase settings*, thêm một luật khớp, bấm **Preview** | Bảng kết quả hiện ra; cấu hình **chưa được lưu** | ☐ |
| 9 | **US-07** Biết vì sao ra kết quả đó | Xem cột **Winning rule** trong bảng Preview | Mỗi Task ghi rõ luật nào đã thắng và số ưu tiên của nó | ☐ |
| 10 | **US-08** Đếm đúng | Đọc dòng tổng kết | Ghi đúng số Task đổi phân loại, giữ nguyên, và vẫn chưa nhận diện được | ☐ |
| 11 | **US-08** Lưu | Bấm **Confirm save** | Báo tạo version mới và số Epic sẽ được tính lại | ☐ |
| 12 | **US-08** Lỗi neo đúng chỗ | Sửa một luật trỏ tới Phase không tồn tại rồi lưu | Thông báo đỏ hiện **ngay dưới dòng luật đó**, không phải banner ở đầu trang | ☐ |
| 13 | **US-09** Kế thừa theo project | Mở một project, bấm **Override** phần mẫu tiêu đề | Khu Phase và khu luật khớp **vẫn** hiện nhãn *inherited from the Default set* | ☐ |
| 14 | **US-09** Quay lại version cũ | Mở tab **History**, bấm **Roll back to** một version | Tạo version mới; version bị bỏ **vẫn còn** trong danh sách | ☐ |

## Biểu đồ Burndown

| # | User story | Thao tác | Đạt khi thấy | ☐ |
|---|---|---|---|---|
| 15 | **US-03** Xem tổng Epic | Mở biểu đồ của một Epic | Hai đường Kế hoạch và Thực tế; trục ngang **không có** thứ Bảy, Chủ nhật | ☐ |
| 16 | **US-04** Xem một Phase | Bấm tab *Single Phase*, chọn một Phase | Biểu đồ đổi ngay, **không có màn hình chờ tải** | ☐ |
| 17 | **US-05** So sánh các Phase | Bấm tab *Compare Phases*, chọn 2–3 Phase | Mỗi Phase một đường màu riêng | ☐ |
| 18 | **US-11** Giải thích số liệu | Bấm vào một điểm trên biểu đồ | Bảng hiện từng Sub-task, **quy tắc nào** (cột *Rule*) đã áp dụng, và câu giải thích đọc được | ☐ |
| 19 | **US-11** Tìm ra nguyên nhân sai số | Trong bảng đó, tìm dòng ghi *Rule 2* | Hiện rõ ai sửa tay ước lượng, sửa thành bao nhiêu, lúc nào | ☐ |
| 20 | **US-06** Dấu mốc phát sinh việc | Xem khu *Chart markers* | Ngày có phát sinh việc ghi rõ thêm bao nhiêu giờ và Sub-task nào gây ra | ☐ |
| 21 | **US-06** Kế hoạch bị dời | Nếu Epic từng bị dời mốc | Ghi rõ dời từ ngày nào sang ngày nào, mấy ngày làm việc, do Sub-task nào | ☐ |
| 22 | **US-03** Nói rõ đường Kế hoạch trôi | Đọc chú thích dưới biểu đồ | Ghi rõ đường Kế hoạch được tính lại sau mỗi lần đồng bộ, **kể cả phần đã qua** | ☐ |

## Bảng Signboard

| # | User story | Thao tác | Đạt khi thấy | ☐ |
|---|---|---|---|---|
| 23 | **US-13** Xem bảng | Mở Signboard của một Phase | Ma trận Function × loại task; mỗi ô có ngày kế hoạch và **chữ** nói trạng thái | ☐ |
| 24 | **US-13** Lọc theo trạng thái | Bấm một mục trên thanh tóm tắt | Các ô khác **mờ đi**, kèm dòng chữ nói rõ *"không phải mất"*. Bấm lần nữa thì bỏ lọc | ☐ |
| 25 | **US-14** Ô gộp nhiều ticket | Tìm ô có huy hiệu `≡N` | Rê chuột thấy danh sách từng ticket kèm trạng thái riêng; ô mang trạng thái **xấu nhất** | ☐ |
| 26 | **US-15** Phân biệt ô trống và thiếu ngày | So một ô `—` với một ô *No planned dates* | Hai thứ **khác hẳn nhau**: ô trống là không có việc đó, ô kia là có việc nhưng thiếu ngày | ☐ |
| 27 | **US-15** Không giấu dữ liệu bẩn | Cuộn xuống khu *Not on the board* | Liệt kê Sub-task đặt tên sai, kèm lý do, và ghi rõ chúng **vẫn được tính vào Burndown** | ☐ |
| 28 | **US-15** Gợi ý thêm cột | Nếu có loại task lạ lặp lại nhiều lần | Hệ thống gợi ý thêm cột, bấm là sang thẳng màn hình cấu hình với mã đã điền sẵn | ☐ |
| 29 | **US-13** Tìm Function | Gõ một phần tên Function vào ô tìm kiếm | Tìm ra kể cả khi khác hoa/thường hoặc khác toàn giác/nửa giác | ☐ |

## Cấu hình cột Signboard

| # | Thao tác | Đạt khi thấy | ☐ |
|---|---|---|---|
| 30 | Thêm một cột mới rồi lưu | Bảng Signboard hiện thêm cột đó | ☐ |
| 31 | Đổi thứ tự cột | Thứ tự trên bảng Signboard đổi theo | ☐ |
| 32 | Xoá một cột đang dùng | Cảnh báo nói rõ Sub-task sẽ **rơi khỏi bảng** nhưng **vẫn được tính vào Burndown** | ☐ |
| 32a | Đổi **Side** của một cột (VD: JMReview → *JP does*) rồi lưu | Màn Phase sub-tasks kiểm tra lại các Sub-task loại đó bằng **lịch JP** (xem mục Ngày nghỉ bên dưới) | ☐ |

## Ngày nghỉ & kiểm tra plan (T-36 → T-38)

| # | Thao tác | Đạt khi thấy | ☐ |
|---|---|---|---|
| 36 | Đăng nhập ADMIN, mở **Days off**, tab lịch VN, dán `2026-02-17, Tết` rồi Import | Bảng hiện ngày kèm thứ và tên; thông báo nói rõ mấy ngày thêm/ghi đè và mấy Epic sẽ tính lại | ☐ |
| 37 | Dán kèm một dòng sai (`17/02/2026`) | Preview chỉ đích danh dòng sai; **không import gì** cho tới khi sửa | ☐ |
| 38 | Import bằng chế độ *Replace all of {năm}* | Ngày cũ của năm không có trong danh sách mới **biến mất**; năm khác giữ nguyên | ☐ |
| 39 | Đăng nhập PM, mở Days off | Xem được nhưng **không có** nút Import/Delete | ☐ |
| 40 | Sau khi import + Resync, mở biểu đồ Epic vắt qua ngày lễ | Đường Kế hoạch **đi ngang** qua ngày lễ (không giảm); trục ngang không có ngày lễ đó | ☐ |
| 41 | Mở biểu đồ Epic mà lịch **chưa khai** ngày lễ năm nay | Cảnh báo 📅 nói rõ lịch chưa có ngày lễ và cách khắc phục | ☐ |
| 42 | Đặt `wbs_end_date` một Sub-task JMReview (Side = JP) vào đúng ngày lễ Nhật, sync | Màn Phase sub-tasks: banner đỏ + badge ⚠ trên dòng đó, ghi rõ ngày và **tên ngày lễ JP**; cùng ngày đó Sub-task phía VN **không** bị báo | ☐ |
| 43 | Đặt `wbs_start_date` một Sub-task Create (Side = VN) vào thứ Bảy, sync | Badge ⚠ ghi *weekend* phía VN; màn Epics cột **On days off** đếm được và bấm sang được màn Sub-tasks | ☐ |
| 44 | Sub-task có khoảng plan **vắt qua** cuối tuần (hai mốc đều ngày làm việc) | **Không** bị báo vi phạm | ☐ |
| 45 | Thêm Epic mới ở màn Epics | Có ô chọn lịch (mặc định VN_STANDARD); lịch chưa có ngày lễ hiện ⚠ ngay trong ô chọn | ☐ |

## Giám sát vận hành

| # | User story | Thao tác | Đạt khi thấy | ☐ |
|---|---|---|---|---|
| 33 | **US-12** Xem tình trạng hệ thống | Mở *Monitoring* | Mọi số đo hiện dạng `giá trị / ngưỡng`, không phải chỉ một con số | ☐ |
| 34 | **US-12** Biết số liệu lấy lúc nào | Nhìn đầu màn hình | Ghi rõ thời điểm lấy số liệu; tắt được tự làm mới | ☐ |
| 35 | **US-12** Xử lý Epic lỗi | Nếu có Epic đang lỗi | Hiện **nguyên văn** thông báo lỗi và nút **Run again** ngay cạnh | ☐ |

---

## Ghi chú của người nghiệm thu

**Chỗ phải hỏi dev** (mỗi dòng là một lỗ hổng tài liệu cần vá):

-
-

**Kết luận:** ☐ Đạt ☐ Đạt có điều kiện ☐ Chưa đạt

Người nghiệm thu: ______________  Ngày: ______________
