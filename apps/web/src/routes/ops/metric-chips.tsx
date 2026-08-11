import type { OpsMetric } from '@app/shared';
import { Badge, type BadgeTone } from '../../components/ui/index.js';

/**
 * Dãy chip số đo `giá trị / ngưỡng` — dùng chung cho nhóm toàn cục và từng Epic.
 *
 * Tách khỏi màn hình chính để phần Data quality theo Epic không phải chép lại
 * quy tắc "luôn hiện ngưỡng" và "chưa đo được thì nói thẳng".
 */

export const LEVEL_TONE: Record<string, BadgeTone> = {
  OK: 'success',
  WARN: 'warning',
  CRITICAL: 'danger',
  UNKNOWN: 'muted',
};

export function MetricChips({ metrics }: { readonly metrics: readonly OpsMetric[] }) {
  return (
    <ul className="chips">
      {metrics.map((m) => (
        <li key={m.name}>
          <Badge tone={LEVEL_TONE[m.level] ?? 'muted'} title={`Threshold: ${m.threshold} ${m.unit}`}>
            {/* Luôn hiện `giá trị / ngưỡng`: số đo không kèm ngưỡng thì vô nghĩa. */}
            {m.label}: {m.value === null ? 'not measured yet' : `${m.value} / ${m.threshold} ${m.unit}`}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
