import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './error-state.js';

/**
 * Lưới an toàn cuối cùng.
 *
 * Một lỗi ném ra trong lúc React vẽ sẽ gỡ TOÀN BỘ cây component và để lại trang
 * trắng tinh — không thông báo, không nút bấm, người dùng không biết chuyện gì
 * xảy ra. Component này biến trang trắng đó thành một thông báo đọc được kèm
 * nút thử lại.
 *
 * Phải viết bằng class: React chưa có cách bắt lỗi vẽ bằng hook.
 */

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Gọi khi người dùng bấm "Thử lại" — chỗ để xoá cache query hỏng. */
  readonly onReset?: (() => void) | undefined;
}

interface ErrorBoundaryState {
  readonly error: unknown;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Giữ lại vết trong console: người dùng thấy câu tiếng Việt, còn dev cần
    // biết component nào ném lỗi.
    console.error('Uncaught error in the component tree', error, info.componentStack);
  }

  private readonly handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <ErrorState
        error={this.state.error}
        title="This screen crashed"
        onRetry={this.handleReset}
      />
    );
  }
}
