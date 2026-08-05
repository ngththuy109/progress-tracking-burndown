import { useMemo, useState, type ReactNode } from 'react';

/**
 * Bảng dữ liệu dùng chung.
 *
 * Sẽ dùng cho CẢ danh sách Epic LẪN bảng Signboard, nên cố tình để mềm:
 *   • `render` toàn quyền vẽ ô — Signboard cần ô gộp nhiều ticket kèm huy hiệu
 *     số lượng và tooltip, không phải một chuỗi phẳng.
 *   • `sortKey` là tuỳ chọn — cột nào không có thì không sắp xếp được, thay vì
 *     bịa ra một cách so sánh sai.
 *
 * Bảng KHÔNG tự gọi API. Ai dùng thì tự lấy dữ liệu rồi truyền vào.
 */

export type SortDirection = 'asc' | 'desc';

/** Giá trị đem đi so sánh. `null` = ô thiếu dữ liệu. */
export type SortValue = string | number | null;

export interface Column<Row> {
  readonly key: string;
  readonly header: ReactNode;
  readonly render: (row: Row) => ReactNode;
  readonly align?: 'left' | 'center' | 'right' | undefined;
  readonly width?: string | undefined;
  /** Có hàm này thì cột sắp xếp được. */
  readonly sortKey?: ((row: Row) => SortValue) | undefined;
}

export interface DataTableProps<Row> {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  /** Chú thích bảng, cho trình đọc màn hình. */
  readonly caption: string;
  /** Hiện khi `rows` rỗng. */
  readonly empty?: ReactNode;
}

/**
 * So sánh hai ô.
 *
 * QUY TẮC: ô thiếu dữ liệu LUÔN xuống cuối, cả khi sắp tăng lẫn khi sắp giảm.
 * Nếu để `null` theo hướng sắp xếp thì bấm "sắp theo ngày kết thúc" sẽ đẩy toàn
 * bộ Sub-task thiếu ngày lên đầu bảng và che mất dữ liệu thật.
 */
export function compareSortValues(a: SortValue, b: SortValue, dir: SortDirection): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const base =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : // Vẫn đối chiếu theo tiếng Việt dù chữ trên màn hình là tiếng Anh: dữ
        // liệu đến từ Jira và tên Function/Epic thường có dấu. `Đ` phải đứng sau
        // `D`, không phải sau `Z`.
        String(a).localeCompare(String(b), 'vi');

  return dir === 'asc' ? base : -base;
}

export function DataTable<Row>({ columns, rows, rowKey, caption, empty }: DataTableProps<Row>) {
  const [sort, setSort] = useState<{ key: string; dir: SortDirection } | null>(null);

  const sortedRows = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((c) => c.key === sort.key);
    const sortKey = column?.sortKey;
    if (sortKey === undefined) return rows;
    // Sao chép trước khi sắp: `rows` là mảng của người gọi, sắp tại chỗ sẽ sửa
    // luôn cache của TanStack Query.
    return [...rows].sort((x, y) => compareSortValues(sortKey(x), sortKey(y), sort.dir));
  }, [rows, columns, sort]);

  const toggleSort = (key: string): void => {
    setSort((prev) =>
      prev === null || prev.key !== key
        ? { key, dir: 'asc' }
        : { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' },
    );
  };

  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;

  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="table__caption">{caption}</caption>
        <thead>
          <tr>
            {columns.map((col) => {
              const sortable = col.sortKey !== undefined;
              const active = sort !== null && sort.key === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  style={col.width === undefined ? undefined : { width: col.width }}
                  className={`table__th table__th--${col.align ?? 'left'}`}
                  // `aria-sort` là cách trình đọc màn hình biết bảng đang sắp
                  // theo cột nào — mũi tên ▲▼ chỉ người nhìn thấy mới hiểu.
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {sortable ? (
                    <button type="button" className="table__sort" onClick={() => toggleSort(col.key)}>
                      {col.header}
                      <span aria-hidden="true">{active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕'}</span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((col) => (
                <td key={col.key} className={`table__td table__td--${col.align ?? 'left'}`}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
