import { ALERT_COOLDOWN_SECONDS, ALERT_SPEC, type Alert, type AlertChannelName } from '@app/shared';

/**
 * Gửi cảnh báo đi đúng kênh, và KHÔNG gửi lặp lại — PRD §10.4.
 *
 * Cảnh báo sai còn tệ hơn không có cảnh báo: một ngưỡng kêu mỗi phút sẽ bị tắt
 * tiếng trong tuần đầu, và lúc có chuyện thật thì không ai đọc nữa.
 */

export interface AlertChannel {
  readonly name: AlertChannelName;
  send(alert: Alert): Promise<void>;
}

/** Phần Redis mà bộ chống lặp cần. `SET NX EX` là một lệnh nguyên tử. */
export interface DedupRedis {
  set(key: string, value: string, mode: 'EX', ttl: number, condition: 'NX'): Promise<string | null>;
}

export interface DispatcherDeps {
  readonly channels: readonly AlertChannel[];
  readonly redis: DedupRedis;
  readonly log?: (event: Record<string, unknown>) => void;
}

/**
 * Khoá chống lặp gồm CẢ mã cảnh báo LẪN Epic.
 *
 * Thiếu phần Epic thì một Epic đang lỗi sẽ chặn cảnh báo của 49 Epic còn lại,
 * và sự cố lớn hơn bị che sau sự cố nhỏ hơn.
 */
export function dedupKey(alert: Alert): string {
  return `alert:sent:${alert.code}:${alert.epicKey ?? 'SYSTEM'}`;
}

export interface DispatchResult {
  readonly sent: number;
  readonly suppressed: number;
  readonly failedChannels: readonly string[];
}

export function createAlertDispatcher(deps: DispatcherDeps) {
  const log = deps.log ?? (() => undefined);

  return {
    async dispatch(alerts: readonly Alert[]): Promise<DispatchResult> {
      let sent = 0;
      let suppressed = 0;
      const failedChannels: string[] = [];

      for (const alert of alerts) {
        const spec = ALERT_SPEC[alert.code];
        const ttl = ALERT_COOLDOWN_SECONDS[spec.level];

        // `SET NX EX` nguyên tử: hai worker cùng phát hiện một sự cố thì chỉ một
        // cái gửi được. Đọc-rồi-ghi bằng hai lệnh sẽ để lọt cảnh báo trùng.
        const acquired = await deps.redis.set(dedupKey(alert), '1', 'EX', ttl, 'NX');
        if (acquired === null) {
          suppressed += 1;
          log({ event: 'alert.suppressed', code: alert.code, epicKey: alert.epicKey, cooldownSeconds: ttl });
          continue;
        }

        for (const channel of deps.channels) {
          if (!spec.channels.includes(channel.name)) continue;
          try {
            await channel.send(alert);
          } catch (err) {
            // Slack chết KHÔNG được làm sập job đêm. Ghi log rồi chạy tiếp —
            // mất một thông báo còn hơn mất cả lượt chốt sổ.
            failedChannels.push(channel.name);
            log({ event: 'alert.channelFailed', channel: channel.name, code: alert.code, message: String(err) });
          }
        }

        sent += 1;
        log({ event: 'alert.sent', code: alert.code, level: spec.level, epicKey: alert.epicKey });
      }

      return { sent, suppressed, failedChannels };
    },
  };
}
