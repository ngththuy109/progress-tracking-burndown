/**
 * Tắt worker sạch sẽ — PRD §9.5.
 *
 * Đây là yêu cầu vận hành, không phải chi tiết cho đẹp. Deploy giữa lúc job đêm
 * đang chạy mà giết tiến trình ngay thì:
 *   • khoá Redis còn treo tới hết TTL 15 phút → Epic đó bị bỏ qua cả lượt;
 *   • dòng `sync_run` mắc kẹt ở `RUNNING` mãi mãi → người trực không biết job
 *     đã chạy hay chưa.
 *
 * Toàn bộ file này nhận CỔNG chứ không nhận `Worker` của BullMQ, nên test được
 * đầy đủ mà không cần Redis.
 */

export interface Closable {
  close(): Promise<void>;
}

/** Hạn chờ job đang chạy hoàn tất. Quá hạn thì thoát với mã lỗi. */
export const SHUTDOWN_TIMEOUT_MS = 30_000;

export interface ShutdownDeps {
  /** Đóng TRƯỚC: ngừng nhận job mới và chờ job đang chạy. */
  readonly workers: readonly Closable[];
  /** Đóng SAU: Redis, Prisma, hàng đợi. Đóng sớm là cắt chân job đang chạy. */
  readonly connections: readonly Closable[];
  readonly timeoutMs?: number;
  readonly log?: (event: Record<string, unknown>) => void;
  readonly onExit?: (code: number) => void;
  /** Cho test tua thời gian mà không phải chờ thật. */
  readonly delay?: (ms: number) => Promise<void>;
}

export interface ShutdownHandle {
  /** Gọi nhiều lần là an toàn — bấm Ctrl+C hai lần không được ném lỗi. */
  run(reason: string): Promise<void>;
  readonly closedOrder: readonly string[];
}

export function createShutdown(deps: ShutdownDeps): ShutdownHandle {
  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const log = deps.log ?? (() => undefined);
  const delay = deps.delay ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const closedOrder: string[] = [];

  let running: Promise<void> | null = null;

  async function closeAll(reason: string): Promise<void> {
    log({ event: 'shutdown.start', reason, timeoutMs });

    let timedOut = false;

    // Cờ để nhánh chờ hạn không giữ tiến trình sống sau khi worker đã xong.
    const workersClosed = Promise.all(
      deps.workers.map(async (w, i) => {
        await w.close();
        closedOrder.push(`worker[${i}]`);
      }),
    ).then(() => 'closed' as const);

    const deadline = delay(timeoutMs).then(() => 'timeout' as const);
    const outcome = await Promise.race([workersClosed, deadline]);

    if (outcome === 'timeout') {
      timedOut = true;
      log({
        event: 'shutdown.timeout',
        message:
          `The running job did not finish within ${timeoutMs}ms. Forcing exit. ` +
          'The Redis lock of the Epic being processed will expire on its own; check sync_run for rows stuck in RUNNING.',
      });
    }

    // Kết nối luôn đóng SAU worker, kể cả khi quá hạn — đóng Redis trước là cắt
    // chân chính cái job đang cố hoàn tất.
    for (const [i, c] of deps.connections.entries()) {
      try {
        await c.close();
        closedOrder.push(`connection[${i}]`);
      } catch (err) {
        // Một kết nối đóng lỗi không được chặn những cái còn lại.
        log({ event: 'shutdown.connectionError', index: i, message: String(err) });
      }
    }

    log({ event: 'shutdown.done', timedOut, closedOrder });
    deps.onExit?.(timedOut ? 1 : 0);
  }

  return {
    run(reason: string): Promise<void> {
      // Lần gọi thứ hai bám vào lần đầu thay vì chạy song song một lượt đóng nữa.
      running ??= closeAll(reason);
      return running;
    },
    closedOrder,
  };
}

export interface SignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
}

/** Nối `SIGTERM` / `SIGINT` vào quy trình tắt sạch. */
export function registerSignalHandlers(handle: ShutdownHandle, source: SignalSource): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    source.on(signal, () => {
      void handle.run(signal);
    });
  }
}
