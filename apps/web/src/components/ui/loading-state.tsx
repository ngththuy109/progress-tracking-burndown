/**
 * Trạng thái "đang tải".
 *
 * Có chữ THẬT chứ không chỉ mấy thanh xám: trình đọc màn hình không đọc được ô
 * xám, và người dùng mạng chậm cần biết là trang đang chạy chứ không phải treo.
 */
export interface LoadingStateProps {
  readonly label?: string | undefined;
  /** Số thanh giả. Đặt xấp xỉ số dòng thật để trang bớt giật khi dữ liệu về. */
  readonly rows?: number | undefined;
}

export function LoadingState({ label = 'Loading…', rows = 3 }: LoadingStateProps) {
  return (
    <div className="state state--loading" role="status" aria-live="polite" aria-busy="true">
      <span className="state__label">{label}</span>
      <div className="skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <span className="skeleton__bar" key={i} />
        ))}
      </div>
    </div>
  );
}
