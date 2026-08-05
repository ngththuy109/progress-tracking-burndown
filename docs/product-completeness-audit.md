# Product Completeness Audit

Audit ứng dụng hiện tại để xác định nó đã trở thành một sản phẩm vận hành trọn vẹn
hay mới chỉ là tập hợp page, API và database operation.

Đừng bắt đầu bằng câu hỏi:

> Ứng dụng còn thiếu feature gì?

Hãy bắt đầu bằng:

> Actor nào chưa hoàn thành được job nào, tại surface nào, vì thiếu khả năng quan
> sát, quyết định, hành động, sửa sai, phòng lỗi, recovery hoặc measurement nào?

Không sửa code trong quá trình audit. Findings và proposals phải được tách thành hai
pha riêng.

---

## 1. Ground rules

### Audit công việc, không audit danh sách feature

Đừng bắt đầu từ sidebar, route hoặc database entity. Bắt đầu từ:

- actor cụ thể;
- trigger khiến họ mở ứng dụng;
- quyết định họ cần đưa ra;
- hành động họ cần hoàn thành;
- kết quả họ cần xác nhận;
- exception họ phải xử lý.

Một job phải mô tả được tình huống, động lực và kết quả. Ví dụ về cấu trúc:

> Khi `<tình huống xảy ra>`, `<actor>` cần `<quan sát/quyết định/hành động>`, để
> `<kết quả có ý nghĩa>`.

Không được lấy page hiện tại làm định nghĩa cho job. Các suy luận kiểu sau là vòng
lặp và không hợp lệ:

```text
Ứng dụng có màn Settings/CRUD
→ job của người dùng là "cấu hình"
→ Settings/CRUD được kết luận là surface phù hợp
```

Hãy khám phá job từ bên ngoài implementation:

- Người dùng phải hoàn thành công việc gì trước khi có ứng dụng này?
- Họ cần quyết định gì theo ngày, tuần, tháng hoặc theo exception?
- Họ đang dùng spreadsheet, giấy, điện thoại hoặc nhiều màn hình để làm gì?
- Khi dữ liệu thay đổi, họ cần thấy impact và phản ứng thế nào?
- Hành động nào lặp lại thường xuyên, hành động nào hiếm nhưng có hậu quả lớn?

### Chia job đủ nhỏ để thấy interaction gap

Không dùng các row mơ hồ như:

- quản lý hệ thống;
- cấu hình dữ liệu;
- quản lý người dùng;
- xử lý đơn hàng.

Tách chúng theo decision và observable outcome. Một job đã đủ nhỏ khi:

- có một trigger rõ;
- có một primary decision;
- có một kết quả kiểm chứng được;
- có thể đánh giá riêng khả năng understand, act, revise, prevent và recover;
- việc thay đổi interaction của job này không mặc nhiên thay đổi mọi job khác.

Nếu một row chứa nhiều object, nhiều horizon hoặc nhiều loại quyết định, tiếp tục
chia nhỏ trước khi audit.

### Evidence trước suy đoán

Mỗi claim về current product phải dẫn tới ít nhất một evidence:

- hành vi quan sát được trên ứng dụng đang chạy;
- source `file:line`;
- API, schema hoặc query có thật;
- automated test hoặc browser test;
- tài liệu product được xác nhận là còn hiệu lực.

Nếu chưa chứng minh được, ghi `ASSUMPTION` hoặc `UNKNOWN`.

Evidence trong code chứng minh **current behavior**, không chứng minh đó là trải
nghiệm đúng. Khi docs, copy, source và browser behavior khác nhau, phải ghi rõ sự
khác biệt; không chọn một nguồn thuận tiện rồi kết luận.

Nhu cầu chưa tồn tại trong code vẫn có thể là một gap hợp lệ nếu nó xuất phát từ:

- job đã được product owner xác nhận;
- hành vi quan sát được của người dùng;
- domain workflow có bằng chứng;
- một hypothesis được ghi rõ để product owner duyệt.

Pattern của sản phẩm tham chiếu chỉ được dùng để sinh hypothesis, không được tự động
biến thành requirement.

### Technical capability chưa phải user capability

Một table, endpoint hoặc screen tồn tại không đồng nghĩa product capability đã hoàn
thành.

Capability chỉ được coi là hoàn thành khi người dùng có thể:

1. tìm thấy và hiểu trạng thái;
2. hành động tại ngữ cảnh hợp lý;
3. nhận feedback rõ;
4. chỉnh sửa hoặc hoàn tác khi phù hợp;
5. được bảo vệ khỏi lỗi có thể dự đoán;
6. phục hồi từ exception;
7. quan sát kết quả cần thiết cho quyết định tiếp theo.

### Giữ domain complexity, giảm interaction complexity

Không xoá business rule thật để làm UI có vẻ đơn giản. Giữ domain invariants; giảm
việc người dùng phải nhớ syntax, chuyển context, nhập lại dữ liệu hoặc tự đối chiếu
nhiều danh sách.

### Findings trước, proposals sau

Trước hết mô tả điều đang đúng hoặc đang thiếu, kèm evidence và product consequence.
Chỉ đề xuất target experience sau khi operating model và coverage matrix hoàn tất.

Không biến preference thành finding. Không đề xuất một view, dashboard hoặc feature
chỉ vì sản phẩm khác có nó.

---

## 2. Product principles

Đây là nguyên lý hành vi và cấu trúc sản phẩm, không phải style guide.

### Object-first, không feature-first

Xác định mental objects người dùng thực sự nghĩ tới, cùng attributes, relationships
và calls-to-action của chúng.

Kiểm tra:

- Primary object của từng actor là gì?
- Information architecture tổ chức quanh object hay quanh module kỹ thuật?
- Người dùng có phải rời object để làm một việc vốn thuộc về nó không?
- Attributes và relationships quan trọng có nhìn thấy và thao tác được không?
- Một thay đổi trên object có cho thấy impact lên các object liên quan không?

Không áp dụng máy móc một primary object cho mọi actor.

### Direct manipulation

Đặt hành động thường xuyên tại nơi người dùng nhìn thấy object hoặc trạng thái cần
thay đổi. Ưu tiên thao tác trực tiếp, tăng tiến, reversible và cho thấy kết quả ngay.

Kiểm tra:

- Daily action có bị đẩy sang một form hoặc page khác không?
- Có thể click, chọn, kéo hoặc sửa ngay trên surface hiện tại không?
- Người dùng có phải xoá rồi tạo lại để thay đổi một thuộc tính không?
- Sau hành động, họ có thấy ngay tác động và trạng thái mới không?

Chọn affordance nhẹ nhất phù hợp với semantic shape:

1. Một giá trị text → inline input.
2. Một giá trị có format hoặc tập lựa chọn → inline control.
3. Một giá trị hiển thị nhưng gồm vài lựa chọn liên quan → anchored popover.
4. Một object nhiều field hoặc collection → modal hoặc focused page.

Không dùng modal cho một giá trị đơn. Không dùng popover để quản lý collection.

### Progressive disclosure

Mặc định phải phục vụ 80% công việc thường xuyên. Advanced hoặc hiếm dùng mới được
disclose thêm.

Kiểm tra:

- Daily fields và actions là gì?
- Monthly hoặc exceptional actions là gì?
- UI có bắt mọi người trả cognitive tax cho trường hợp hiếm không?
- Configuration nào có thể thay bằng default an toàn?
- Capability quan trọng có bị chôn trong menu hoặc disclosure không?

Progressive disclosure không có nghĩa giấu daily action.

### Plain domain language

Tạo vocabulary table giữa từ trong code và từ người dùng thật sử dụng.

Kiểm tra:

- UI có lộ tên table, enum, workflow hoặc implementation concept không?
- Một người ngoài kỹ thuật có hiểu action và error message không?
- Cùng một object có bị gọi bằng nhiều tên ở các surface không?
- Error có nói cả điều sai và cách phục hồi không?

Ngôn ngữ của người dùng là một phần của product contract.

### Domain-specialized experience

Vocabulary, defaults, surfaces và metrics phải phản ánh cách domain thật vận hành,
không phải một generic admin.

Kiểm tra:

- Các default có xuất phát từ hành vi phổ biến trong domain không?
- Constraint quan trọng của domain có được ưu tiên không?
- Surface có mang hình dạng công việc thật không?
- Metric có hỗ trợ một named decision hay chỉ là stat card chung chung?
- Người dùng có cảm thấy sản phẩm hiểu công việc của họ không?

Chỉ đề xuất metric khi nêu được quyết định mà metric đó hỗ trợ.

### Calm technology

UI chỉ nên yêu cầu sự chú ý cần thiết cho công việc hiện tại.

Kiểm tra:

- Những gì đang tranh giành attention?
- Status nào thực sự cần màu hoặc cảnh báo?
- Có page nào chứa nhiều panel ngang hàng nhưng không có primary task?
- Có notification thay cho trạng thái lẽ ra phải thấy ngay trên object không?
- Có thể cắt hoặc demote gì mà không làm yếu job?

Calm không có nghĩa thiếu information. Information phải xuất hiện đúng lúc, đúng mức
và đúng context.

---

## 3. Workspace-shaped principle

Surface chính phải mang hình dạng của công việc, không mang hình dạng của database.

Ví dụ:

- scheduling → thời gian, tài nguyên và availability;
- inventory → stock movement và availability;
- support → conversation và queue;
- sales → account, opportunity và next action;
- content → document, revision và publishing state.

Nếu công việc chính diễn ra trên một timeline, map, queue, canvas hoặc document,
action thường xuyên phải bắt đầu từ surface đó. Một form cộng danh sách phẳng chưa
phải workspace phù hợp chỉ vì CRUD đã đầy đủ.

`Workspace-shaped` không có nghĩa sao chép giao diện của một sản phẩm tham chiếu. Nó
có nghĩa chọn representation phù hợp với object, relationships, decisions và
frequency của công việc.

### Counterfactual task test

Với mỗi core job, giả sử người dùng:

- không biết tên page;
- không biết route;
- không biết data model;
- chỉ biết mục tiêu thực tế của mình.

Từ surface tự nhiên nhất, họ có:

1. nhận ra nên bắt đầu ở đâu;
2. nhìn thấy context cần thiết;
3. thực hiện primary action;
4. sửa quyết định;
5. hiểu constraint trước khi gây lỗi;
6. biết kết quả và next action;
7. phục hồi khi việc không diễn ra theo happy path?

Nếu câu trả lời phụ thuộc vào việc nhớ một route, chuyển sang page không liên quan,
tự đối chiếu nhiều list hoặc xoá rồi tạo lại, đó là structural UX gap.

### Nearest-wrong-action test

Counterfactual test dừng ở "hoàn thành được hay tắc ở đâu". Chưa đủ. Người dùng
thật khi tắc KHÔNG dừng lại — họ **thử động tác gần nhất trông có vẻ đúng**. Bước
này audit đúng khoảnh khắc đó.

Với mỗi job mà counterfactual test cho kết quả FAIL (hoặc tắc), hỏi tiếp:

1. Khi bí, người dùng sẽ **với tay vào control nào gần nhất về mặt ngữ nghĩa**?
   (ví dụ: cần "báo KTV nghỉ ốm 1 hôm" mà không có nút đó → họ bấm "Cho ngưng
   làm" trong phần quản lý nhân viên, vì đó là thứ gần nghĩa nhất.)
2. Động tác gần-nhất-nhưng-sai đó gây **hậu quả gì**?
3. Người dùng có được **cảnh báo trước** hậu quả đó không, hay nó xảy ra âm thầm?
4. Hậu quả có **hiển thị** để người dùng nhận ra và sửa không, hay nó ẩn?

Nếu động tác gần-nhất-nhưng-sai gây thay đổi âm thầm lên một object khác mà không
cảnh báo và không hiển thị — đó là **Silent side-effect gap** (loại nguy hiểm
nhất: không phải "không làm được việc" mà là "làm một việc trông hợp lý rồi gây
hại mà không ai biết").

Lưu ý phương pháp: bước này **rất khó tự chấm nếu người audit cũng là người xây**
— người xây có "hàng rào tri thức" vô hình, tránh nút sai theo bản năng nên không
bao giờ đi vào bẫy. Ưu tiên chạy bước này với con-mắt-không-biết-code (xem
completion gate về independent audit).

### Workspace interaction coverage

Audit mỗi primary workspace qua toàn bộ lớp interaction sau, kể cả khi current UI
không có control tương ứng:

| Lớp | Câu hỏi |
|---|---|
| **Entry** | Actor đến đây từ trigger nào; next action có hiển nhiên không? |
| **Empty space** | Khoảng trống/empty state có phải một nơi tự nhiên để tạo object không? |
| **Existing object** | Click/chọn object cho phép xem và làm những action thường xuyên nào? |
| **Create** | Có thể tạo từ đúng context và được prefill context không? |
| **Revise** | Có thể edit, move, resize, reorder hoặc reschedule mà không xoá-tạo-lại không? |
| **Perspectives** | Có cần list, detail, map, timeline, day/week/month hoặc history để đưa ra các decision khác nhau không? |
| **Relationships** | Quan hệ giữa objects có nhìn thấy, lọc và chỉnh được không? |
| **Constraints** | Rule được thấy trước, phòng ngừa trong lúc làm hay chỉ báo sau submit? |
| **Repeated work** | Có cần copy, bulk, template hoặc repeat action không? |
| **Exceptions** | Conflict, partial failure, empty result và recovery được xử lý ở đâu? |
| **Measurement** | Workspace có trả lời câu hỏi vận hành/kinh doanh liên quan không? |

Không phải workspace nào cũng cần mọi control hoặc perspective. Mỗi capability được
đề xuất vẫn phải gắn với một named job/decision.

---

## 4. Audit process

### Phase 0 — Establish ground truth

Scout song song khi có thể:

1. **Domain:** entities, relationships, states, invariants và derived values.
2. **Capabilities:** routes, commands, services và backend behavior.
3. **Surfaces:** pages, controls, navigation, interaction và UI states.
4. **Evidence:** tests, product docs, screenshots, analytics và audit data.

Các scout chỉ báo facts với evidence; không tự thiết kế giải pháp. Phần tổng hợp phải
được thực hiện sau khi cả bốn góc nhìn đã được đối chiếu.

Chạy ứng dụng và thực hiện các core flows bằng browser. Chỉ đọc code không đủ để
đánh giá interaction.

Không giới hạn job inventory vào những flow app đã hỗ trợ. Tạo thêm danh sách
`CANDIDATE JOBS` từ product docs, user evidence và domain hypotheses. Product owner
phải xác nhận hypothesis trước khi nó trở thành requirement, nhưng audit vẫn phải
hiển thị nó thay vì im lặng bỏ qua.

### Phase 1 — Reconstruct the operating model

Lập bảng:

| Actor | Trigger | Job | Decision | Action | Expected result | Common exceptions |
|---|---|---|---|---|---|---|

Sau đó dựng object relationship map:

```text
Actor → object họ quản lý
Object → attributes quan trọng
Object → relationships
Relationship → business rule/invariant
State transition → action tạo ra transition
```

Phân biệt rõ:

- implementation đang làm gì;
- product docs nói gì;
- điều gì chưa được quyết định;
- điều gì chỉ là suy đoán.

Sau khi lập bảng lần đầu, chạy granularity check:

- Row nào chỉ nhắc tên module/page thay vì outcome?
- Row nào gộp create, edit, planning, exception và reporting?
- Row nào gộp daily operation với weekly/monthly decision?
- Row nào chấm một điểm thấp nhưng không thể biết interaction nào gây ra?

Tách các row đó rồi mới sang Phase 2.

### Phase 2 — Identify workspaces and perspectives

Với mỗi job, xác định surface tự nhiên nhất để bắt đầu và các perspective cần thiết:

- **Temporal:** now, day, week, month hoặc historical.
- **Object:** đối tượng nào cần được nhìn hoặc thao tác.
- **Operational:** cần làm gì ngay.
- **Managerial:** cần đo hoặc quyết định gì.
- **Exception:** cần cứu tình huống gì.

Không tự động đề xuất mọi perspective. Mỗi view phải gắn với một named decision.

Với mỗi primary workspace, bắt buộc chạy:

1. Counterfactual task test.
2. Workspace interaction coverage.
3. Kiểm tra daily actions có nằm tại context tự nhiên không.
4. Kiểm tra blank space, existing object và selection state có affordance phù hợp
   không.
5. Kiểm tra mỗi temporal/object perspective đang hỗ trợ quyết định nào và perspective
   nào còn thiếu evidence.

### Phase 3 — Build the Job × Capability Matrix

Mỗi row là một job, không phải một table trong database.

| Job | Understand | Act | Revise/undo | Prevent error | Recover exception | Monitor/measure |
|---|---:|---:|---:|---:|---:|---:|

Chấm từng ô:

- `0 — ABSENT`: không có.
- `1 — TECHNICAL ONLY`: data/API có nhưng người dùng không với tới.
- `2 — THIN UI`: có screen/control nhưng chỉ đọc hoặc CRUD thô.
- `3 — USABLE`: happy path hoàn thành được với feedback phù hợp.
- `4 — OPERATIONAL`: edit/reversal, prevention, exception và measurement đủ cho
  công việc thật.

Mỗi điểm phải có evidence. Không tính điểm trung bình để che một ô `0` quan trọng.

Nếu một row nhận nhiều điểm khác nhau tuỳ object hoặc interaction, row đó còn quá
rộng và phải tách nhỏ.

### Phase 4 — Run the principle audit

Với từng core workspace, trả lời:

#### Object-first

- Primary object có rõ không?
- Attributes và relationships quan trọng có nhìn thấy không?
- Action có nằm trên đúng object không?

#### Direct manipulation

- Daily action có thực hiện tại context tự nhiên không?
- Edit có nhẹ và reversible không?
- Có thao tác “xoá rồi tạo lại” nào chứng minh thiếu edit không?
- Blank space và existing object có affordance tự nhiên không?
- Context có được prefill khi action bắt đầu từ một object, slot hoặc selection không?
- Có thao tác move, resize, reorder, reschedule hoặc bulk nào phù hợp với job không?

#### Progressive disclosure

- 80% case có nhanh không?
- Advanced case có tồn tại mà không gây nhiễu không?
- Default có thay được configuration nào không?

#### Plain domain language

- Có engine leak hoặc vocabulary drift không?
- Label và error có giúp người dùng hành động tiếp không?

#### Domain specialization

- Surface, default và metric có phản ánh công việc thật không?
- Hay chỉ là generic dashboard và generic CRUD?
- Relationships và constraints quan trọng có trở thành representation trực quan
  không?
- Các temporal/object perspectives có khớp những horizon ra quyết định thực tế không?

#### Calm technology

- Attention có dành cho current task và real exception không?
- Có panel, card, banner hoặc notification nào không kiếm được chỗ của nó không?

### Phase 5 — Classify the gaps

| Gap type | Dấu hiệu |
|---|---|
| **Invisible capability** | Backend/data có, UI không có đường vào |
| **CRUD façade** | Có form/list nhưng không hoàn thành job vận hành |
| **Misplaced action** | Làm được nhưng phải rời context tự nhiên |
| **Missing perspective** | Thiếu horizon/lens cần cho một named decision |
| **Relationship opacity** | Quan hệ domain có nhưng người dùng phải tự đối chiếu |
| **Constraint invisibility** | Rule chỉ xuất hiện sau lỗi hoặc hoàn toàn không hiện |
| **Revision gap** | Tạo được nhưng không sửa hoặc undo được |
| **Exception gap** | Happy path có nhưng không recovery được |
| **Management gap** | Có dữ liệu nhưng không trả lời câu hỏi vận hành/kinh doanh |
| **Vocabulary gap** | UI nói bằng từ của implementation thay vì người dùng |
| **Attention gap** | Information và actions ngang hàng, không có ưu tiên |
| **Silent side-effect** | Một action hợp lệ trên object A gây thay đổi không-hiển-thị lên object B, người dùng không được cảnh báo trước và không thấy hậu quả sau |

Một finding có thể thuộc nhiều loại, nhưng phải chọn một primary type.

**Silent side-effect thường bị nâng lên P0/P1** dù trông "nhỏ": khác với các gap
kiểu "không làm được việc" (gây khó chịu, người dùng biết mình tắc), silent
side-effect khiến người dùng **tưởng đã làm đúng** trong khi gây mất mát ẩn (mất
dữ liệu, bỏ rơi khách, sai trạng thái không ai thấy). Nó phát hiện được gần như
chỉ bằng nearest-wrong-action test với con-mắt-không-biết-code — người-xây tránh
nút sai theo bản năng nên không đi vào bẫy.

### Phase 6 — Prioritize by product consequence

Đánh giá **severity/value** độc lập với **delivery ease**.

Severity/value:

- **Frequency:** người dùng gặp bao thường xuyên?
- **Consequence:** mất thời gian, mất tiền, sai trạng thái, mất dữ liệu hay chỉ khó chịu?
- **Decision blockage:** gap có chặn một quyết định quan trọng không?
- **Flow leverage:** fix này hoàn thiện một loop hay chỉ thêm một control?

Delivery ease:

- **Technical leverage:** capability nền đã có đến đâu?
- **Cost/risk:** cần thay đổi contract, invariant hoặc migration nào?
- **Evidence confidence:** finding đã được chứng minh đến mức nào?

Mức ưu tiên:

- `P0`: gây mất tiền/dữ liệu hoặc hành vi nguy hiểm.
- `P1`: core job thường xuyên không hoàn thành hoặc dễ sai.
- `P2`: cần khi vận hành ở quy mô cao hơn hoặc để quản lý tốt hơn.
- `P3`: refinement, preference hoặc trường hợp hiếm.

Đừng nâng severity chỉ vì UI xấu. Đừng hạ severity chỉ vì backend đã có.
Đừng nâng một gap thành `P0` chỉ vì nó có giá trị kinh doanh cao. Backend đã sẵn hay
fix rẻ chỉ ảnh hưởng recommendation order, không thay đổi severity.

Report cả hai:

| Gap | Product priority | Delivery ease | Evidence confidence |
|---|---|---|---|

Một gap `P1` dễ làm có thể được recommend trước một gap `P1` khó làm. Một gap `P2`
không được đổi nhãn thành `P0` để biện minh cho roadmap.

### Phase 7 — Propose coherent target experiences

Không đề xuất danh sách component kiểu:

- thêm button;
- thêm chart;
- thêm modal;
- thêm một view.

Mỗi proposal phải là một target experience end-to-end:

```text
Actor + trigger
→ entry surface
→ information họ thấy
→ decision họ đưa ra
→ action và feedback
→ constraint được bảo vệ
→ exception/recovery
→ result/measurement
```

Với mỗi proposal, ghi:

1. Job và product outcome.
2. Current experience và evidence.
3. Target flow.
4. Objects, relationships và perspectives liên quan.
5. Interaction/affordance phù hợp.
6. Backend/API đã có gì và còn thiếu gì.
7. Rules không được phá.
8. Empty/loading/error/success/exception states.
9. Acceptance scenarios bằng ngôn ngữ business.
10. Out of scope.

Trước khi chọn proposal, ghi **toàn bộ gap backlog** đã chứng minh. Không bỏ structural
UX gaps chỉ vì report chỉ phát triển sâu tối đa ba target experiences.

Mỗi gap từ `P0` đến `P2` phải có `screen-level implication` ngắn:

- surface tự nhiên;
- entry point;
- primary interaction;
- perspective cần thiết;
- constraint/relationship phải hiện;
- states quan trọng.

Sau đó mới phát triển sâu tối đa ba proposal khác biệt. Chọn một recommendation
nhưng để product owner quyết định scope và policy.

### Phase 8 — State the design boundary

Product Completeness Audit phải đi tới:

- structural UX findings;
- interaction direction;
- target experience;
- screen-level implications;
- states và acceptance scenarios.

Audit không cần tự hoàn thành:

- visual hierarchy chi tiết;
- wireframe có kích thước;
- responsive layout;
- component specification;
- typography, color hoặc design tokens.

Các nội dung đó thuộc bước `Interaction/UX Specification` sau khi product owner chọn
target experience. Nếu brief yêu cầu cả hai, vẫn xuất audit trước và design spec sau;
không dùng visual polish để che structural gap.

---

## 5. Required report

```markdown
# Product Completeness Audit

## 1. Executive diagnosis
Product đang phản chiếu công việc hay phản chiếu implementation?

## 2. Operating model
Bảng actor/job/decision/exception.

## 3. Object relationship map
Mermaid hoặc text map, kèm business rules.

## 4. Workspace and perspective map
Mỗi job bắt đầu ở đâu; cần lens nào và vì sao.

## 5. Workspace interaction audit
Entry · empty space · existing object · create · revise · perspectives ·
relationships · constraints · repeated work · exceptions · measurement.
Kèm kết quả counterfactual test và nearest-wrong-action test (job nào FAIL thì
người dùng bí sẽ làm gì, có gây silent side-effect không). Nếu audit chạy bằng
con-mắt-không-biết-code, ghi rõ; nếu không, ghi giới hạn bias người-trong-cuộc.

## 6. Job × Capability Matrix
Điểm 0–4 kèm evidence.

## 7. Principle findings
Object-first, direct manipulation, progressive disclosure, plain domain language,
domain specialization và calm technology.

## 8. Complete ranked product-gap backlog
ID · primary type · product priority · delivery ease · evidence confidence ·
actor/job · evidence · consequence · screen-level implication.

## 9. Coherent target experiences
Tối đa ba phương án; không phải danh sách component.

## 10. Recommendation
Chọn một flow có product leverage cao nhất và giải thích trade-off.

## 11. Decisions required from product owner
Chỉ hỏi những ambiguity làm thay đổi product behavior hoặc scope.

## 12. Design handoff boundary
Phần nào đã đủ để chọn direction; phần nào cần Interaction/UX Specification tiếp.
```

---

## 6. Completion gates

- [ ] Đã chạy ứng dụng và thử core flows theo từng actor.
- [ ] Đã scout UI, API/capabilities, domain/data và evidence.
- [ ] Mọi current-state claim có evidence hoặc được đánh dấu `ASSUMPTION/UNKNOWN`.
- [ ] Đã dựng actor jobs trước khi liệt kê gaps.
- [ ] Job inventory không được suy ngược từ page/module hiện có.
- [ ] Các job mơ hồ như “cấu hình/quản lý” đã được tách theo decision và outcome.
- [ ] Đã dựng object relationships và invariants.
- [ ] Đã chạy counterfactual task test cho từng core job.
- [ ] Với mỗi job FAIL/tắc, đã chạy nearest-wrong-action test: người dùng bí sẽ
      với tay vào control nào gần nhất, và động tác đó có gây silent side-effect
      không.
- [ ] Đã cân nhắc bias người-trong-cuộc: nếu người audit cũng là người xây app,
      ít nhất các job P0/P1 phải được kiểm lại bằng một con-mắt-không-biết-code
      (agent/người không đọc source, chỉ thao tác app), vì người xây tránh nút
      sai theo bản năng nên bỏ sót silent side-effect. Nếu chưa làm được điều
      này, ghi rõ giới hạn đó trong báo cáo thay vì tuyên bố PASS chắc chắn.
- [ ] Đã audit entry, empty space, existing object, create, revise, perspectives,
      relationships, constraints, repeated work, exceptions và measurement của từng
      primary workspace.
- [ ] Mỗi proposed view hoặc metric gắn với một named decision.
- [ ] Không coi endpoint hoặc page tồn tại là capability hoàn chỉnh.
- [ ] Không biến competitor feature thành requirement nếu không có job tương ứng.
- [ ] Không trộn style critique vào product completeness.
- [ ] Toàn bộ gap backlog đã được ghi trước khi chọn tối đa ba target experiences.
- [ ] Mỗi gap P0–P2 có screen-level implication.
- [ ] Product priority không bị thay đổi bởi backend readiness hoặc delivery ease.
- [ ] Không đề xuất fix rời rạc trước target experience end-to-end.
- [ ] Findings và proposals nằm ở hai section riêng.
- [ ] Đã nói rõ ranh giới giữa audit và Interaction/UX Specification.
- [ ] Product owner chưa duyệt thì chưa sửa code.
