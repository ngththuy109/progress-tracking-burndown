import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { Badge } from './badge.js';
import { compareSortValues, DataTable, type Column } from './data-table.js';
import { EmptyState } from './empty-state.js';
import { describeError, ErrorState } from './error-state.js';
import { LoadingState } from './loading-state.js';
import { MultiSelect, type MultiSelectOption } from './multi-select.js';

describe('ErrorState', () => {
  it('hiện nút Try again và gọi lại hàm khi bấm', async () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new ApiError({ code: 'X', message: 'Hỏng rồi.', status: 500 })} onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('KHÔNG hiện nút Try again khi không có gì để thử lại', () => {
    render(<ErrorState error={new ApiError({ code: 'X', message: 'Hỏng rồi.', status: 400 })} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('hiện mã lỗi để người dùng trích dẫn khi báo lỗi', () => {
    render(<ErrorState error={new ApiError({ code: 'CONFIG_INVALID', message: 'Hỏng.', status: 400 })} />);
    expect(screen.getByText('CONFIG_INVALID')).toBeTruthy();
  });

  it('liệt kê từng issue kèm đường dẫn tới ô sai', () => {
    const error = new ApiError({
      code: 'CONFIG_INVALID',
      message: 'Cấu hình chưa hợp lệ.',
      status: 400,
      issues: [{ level: 'ERROR', code: 'ORPHAN', message: 'Phase không tồn tại.', path: 'matchRules.0' }],
    });
    render(<ErrorState error={error} />);

    expect(screen.getByText('matchRules.0')).toBeTruthy();
    expect(screen.getByText(/Phase không tồn tại/)).toBeTruthy();
  });

  it('dùng role="alert" để trình đọc màn hình đọc ngay', () => {
    render(<ErrorState error={new ApiError({ code: 'X', message: 'Hỏng.', status: 500 })} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('describeError', () => {
  it('lỗi thường của JavaScript KHÔNG lấy chuỗi thô của trình duyệt làm dòng chính', () => {
    // Đây là ca dễ tuột nhất: một `TypeError` từ component sẽ đẩy nguyên câu
    // "Cannot read properties of undefined" ra giữa màn hình cho PM đọc.
    const described = describeError(new TypeError('Cannot read properties of undefined'));

    expect(described.message).toContain('Something went wrong');
    expect(described.message).not.toContain('Cannot read properties');
    // Vẫn giữ nguyên văn cho dev, nhưng ở phần chi tiết.
    expect(described.technical).toBe('TypeError: Cannot read properties of undefined');
  });

  it('ApiError giữ nguyên câu tiếng Việt đã soạn ở lớp API', () => {
    const described = describeError(new ApiError({ code: 'NOT_FOUND', message: 'Không tìm thấy Epic.', status: 404 }));
    expect(described.message).toBe('Không tìm thấy Epic.');
    expect(described.code).toBe('NOT_FOUND');
  });

  it('lỗi không phải Error (ai đó ném một chuỗi) vẫn không làm vỡ màn hình', () => {
    expect(describeError('bùm').technical).toBe('bùm');
    expect(describeError(null).technical).toBeNull();
  });
});

describe('EmptyState', () => {
  it('hiện đúng mô tả được truyền vào', () => {
    render(<EmptyState title="Chưa có Epic nào" description="Bấm Thêm Epic để bắt đầu theo dõi." />);

    expect(screen.getByRole('heading', { name: 'Chưa có Epic nào' })).toBeTruthy();
    expect(screen.getByText('Bấm Thêm Epic để bắt đầu theo dõi.')).toBeTruthy();
  });

  it('không có mô tả thì không vẽ đoạn văn rỗng', () => {
    const { container } = render(<EmptyState title="Trống" />);
    expect(container.querySelector('.state__description')).toBeNull();
  });
});

describe('LoadingState', () => {
  it('có chữ thật để trình đọc màn hình đọc được, không chỉ mấy thanh xám', () => {
    render(<LoadingState label="Đang đọc cấu hình…" />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Đang đọc cấu hình…');
    expect(status.getAttribute('aria-busy')).toBe('true');
  });
});

describe('Badge', () => {
  it('nghĩa nằm ở CHỮ, không chỉ ở màu', () => {
    // Người mù màu và bản in đen trắng đều mất sạch nghĩa nếu chỉ có màu.
    render(<Badge tone="danger">Trễ kết thúc</Badge>);
    expect(screen.getByText('Trễ kết thúc')).toBeTruthy();
  });
});

describe('MultiSelect', () => {
  const OPTIONS: readonly MultiSelectOption[] = [
    { value: 'a1', label: 'Nguyễn An', count: 2 },
    { value: 'b2', label: 'Trần Bình', count: 1 },
  ];

  it('chưa chọn gì thì nút hiện chữ "tất cả"', () => {
    render(<MultiSelect label="PIC" allLabel="All PICs" options={OPTIONS} selected={[]} onChange={vi.fn()} />);

    expect(screen.getByText('All PICs')).toBeTruthy();
  });

  it('chọn đúng một mục thì nút hiện TÊN mục đó, không phải "1 selected"', () => {
    // `<details>` luôn dựng cả nội dung trong DOM, nên tên còn xuất hiện ở ô
    // checkbox — nhắm riêng phần tóm tắt trên nút để khỏi bắt nhầm.
    const { container } = render(
      <MultiSelect label="PIC" allLabel="All PICs" options={OPTIONS} selected={['a1']} onChange={vi.fn()} />,
    );

    expect(container.querySelector('.multi-select__summary')?.textContent).toContain('Nguyễn An');
  });

  it('chọn nhiều mục thì nút gộp thành "N selected"', () => {
    render(
      <MultiSelect label="PIC" allLabel="All PICs" options={OPTIONS} selected={['a1', 'b2']} onChange={vi.fn()} />,
    );

    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  it('tích một ô CHECKBOX thì THÊM giá trị đó (chọn nhiều, không thay thế)', async () => {
    const onChange = vi.fn();
    render(<MultiSelect label="PIC" allLabel="All PICs" options={OPTIONS} selected={['a1']} onChange={onChange} />);

    await userEvent.click(screen.getByRole('checkbox', { name: /Trần Bình/ }));

    expect(onChange).toHaveBeenCalledWith(['a1', 'b2']);
  });

  it('bỏ tích một ô đang chọn thì GỠ đúng giá trị đó', async () => {
    const onChange = vi.fn();
    render(
      <MultiSelect label="PIC" allLabel="All PICs" options={OPTIONS} selected={['a1', 'b2']} onChange={onChange} />,
    );

    await userEvent.click(screen.getByRole('checkbox', { name: /Nguyễn An/ }));

    expect(onChange).toHaveBeenCalledWith(['b2']);
  });

  it('nút Clear đưa về rỗng (= tất cả), và bị khoá khi chưa chọn gì', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MultiSelect label="PIC" allLabel="All PICs" options={OPTIONS} selected={['a1']} onChange={onChange} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledWith([]);

    rerender(<MultiSelect label="PIC" allLabel="All PICs" options={OPTIONS} selected={[]} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Clear' }).hasAttribute('disabled')).toBe(true);
  });

  it('hiện số ticket cạnh mỗi mục — thấy khối lượng trước khi lọc', () => {
    render(<MultiSelect label="PIC" allLabel="All PICs" options={OPTIONS} selected={[]} onChange={vi.fn()} />);

    expect(screen.getByText('(2)')).toBeTruthy();
    expect(screen.getByText('(1)')).toBeTruthy();
  });

  it('không có mục nào thì nói rõ, không để popover trống trơn', () => {
    render(<MultiSelect label="PIC" allLabel="All PICs" options={[]} selected={[]} onChange={vi.fn()} />);

    expect(screen.getByText('Nothing to filter here.')).toBeTruthy();
  });
});

describe('compareSortValues', () => {
  it('ô thiếu dữ liệu luôn xuống cuối, cả khi sắp tăng lẫn sắp giảm', () => {
    // Nếu `null` chạy theo hướng sắp xếp thì bấm "sắp theo ngày kết thúc" sẽ
    // đẩy toàn bộ Sub-task thiếu ngày lên đầu và che mất dữ liệu thật.
    expect(compareSortValues(null, 5, 'asc')).toBeGreaterThan(0);
    expect(compareSortValues(null, 5, 'desc')).toBeGreaterThan(0);
    expect(compareSortValues(5, null, 'desc')).toBeLessThan(0);
  });

  it('so số theo giá trị chứ không theo chữ', () => {
    // So kiểu chuỗi thì "10" đứng trước "9".
    expect(compareSortValues(9, 10, 'asc')).toBeLessThan(0);
  });

  it('so chữ theo tiếng Việt — Đ đứng ngay sau D', () => {
    expect(compareSortValues('Đăng nhập', 'Export', 'asc')).toBeLessThan(0);
  });
});

interface Row {
  readonly name: string;
  readonly order: number | null;
}

const ROWS: readonly Row[] = [
  { name: 'Thanh toán', order: 3 },
  { name: 'Đăng nhập', order: 1 },
  { name: 'Báo cáo', order: null },
];

const COLUMNS: readonly Column<Row>[] = [
  { key: 'name', header: 'Tên', render: (r) => r.name, sortKey: (r) => r.name },
  { key: 'order', header: 'Thứ tự', render: (r) => r.order ?? '—', sortKey: (r) => r.order },
];

function rowNames(): string[] {
  return screen.getAllByRole('row').slice(1).map((tr) => tr.querySelector('td')?.textContent ?? '');
}

describe('DataTable', () => {
  it('giữ nguyên thứ tự ban đầu khi chưa bấm sắp xếp', () => {
    render(<DataTable caption="Bảng" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.name} />);
    expect(rowNames()).toEqual(['Thanh toán', 'Đăng nhập', 'Báo cáo']);
  });

  it('bấm tiêu đề cột thì sắp xếp, bấm lần nữa thì đảo chiều', async () => {
    render(<DataTable caption="Bảng" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.name} />);

    await userEvent.click(screen.getByRole('button', { name: /Thứ tự/ }));
    expect(rowNames()).toEqual(['Đăng nhập', 'Thanh toán', 'Báo cáo']);

    await userEvent.click(screen.getByRole('button', { name: /Thứ tự/ }));
    // Đảo chiều nhưng ô thiếu dữ liệu VẪN ở cuối.
    expect(rowNames()).toEqual(['Thanh toán', 'Đăng nhập', 'Báo cáo']);
  });

  it('KHÔNG sửa mảng của người gọi khi sắp xếp', async () => {
    // `rows` là mảng nằm trong cache của TanStack Query. Sắp tại chỗ là sửa
    // luôn cache, và màn hình khác dùng cùng query sẽ đổi thứ tự theo.
    const original = [...ROWS];
    render(<DataTable caption="Bảng" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.name} />);

    await userEvent.click(screen.getByRole('button', { name: /Thứ tự/ }));

    expect(ROWS).toEqual(original);
  });

  it('đánh dấu aria-sort để trình đọc màn hình biết đang sắp theo cột nào', async () => {
    render(<DataTable caption="Bảng" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.name} />);

    await userEvent.click(screen.getByRole('button', { name: /Thứ tự/ }));

    const header = screen.getByRole('columnheader', { name: /Thứ tự/ });
    expect(header.getAttribute('aria-sort')).toBe('ascending');
  });

  it('cột không khai sortKey thì không bấm sắp xếp được', () => {
    const columns: readonly Column<Row>[] = [{ key: 'name', header: 'Tên', render: (r) => r.name }];
    render(<DataTable caption="Bảng" columns={columns} rows={ROWS} rowKey={(r) => r.name} />);

    expect(screen.queryByRole('button', { name: /Tên/ })).toBeNull();
  });

  it('không có dòng nào thì hiện phần rỗng được truyền vào', () => {
    render(
      <DataTable
        caption="Bảng"
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.name}
        empty={<EmptyState title="Chưa có Phase nào" />}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Chưa có Phase nào' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('ô tự vẽ được nội dung phức tạp — bảng Signboard sẽ cần', () => {
    const columns: readonly Column<Row>[] = [
      {
        key: 'cell',
        header: 'Ô',
        render: (r) => (
          <span>
            <Badge tone="danger">Trễ kết thúc</Badge> <em>≡2</em> {r.name}
          </span>
        ),
      },
    ];
    render(<DataTable caption="Bảng" columns={columns} rows={[ROWS[0]!]} rowKey={(r) => r.name} />);

    expect(screen.getByText('Trễ kết thúc')).toBeTruthy();
    expect(screen.getByText('≡2')).toBeTruthy();
  });
});
