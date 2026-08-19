import { useState } from 'react';
import type { LogworkProjectSetting } from '@app/shared';
import { useLogworkSettings, useSetProjectHours } from '../../api/use-logwork.js';

/**
 * Cấu hình giờ/ngày kỳ vọng theo project (quyết định "behind").
 *
 * Dùng `<details>` cho popover native (không cần bắt click ngoài). PM chỉ sửa
 * được project mình phụ trách; project khác hiện chỉ-đọc kèm khoá.
 */
export function CapacitySettings() {
  const query = useLogworkSettings();

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <details>
        <summary className="button" style={{ listStyle: 'none', cursor: 'pointer' }}>
          ⚙ Expected h/day
        </summary>
        <div
          className="panel"
          style={{ position: 'absolute', right: 0, top: '100%', zIndex: 20, width: 320, marginTop: 6 }}
        >
          <h3 className="panel__title" style={{ marginTop: 0 }}>
            Expected hours per day
          </h3>
          {query.isPending && <p className="muted">Loading…</p>}
          {query.isError && <p className="notice notice--error">Could not load settings.</p>}
          {query.data !== undefined && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Drives the “behind” check. Set per project; blank = the calendar default (
                {query.data.defaultHoursPerDay}h). Only a project’s PM or an admin can change it.
              </p>
              {query.data.projects.length === 0 ? (
                <p className="muted">No projects in view.</p>
              ) : (
                <ul className="rows">
                  {query.data.projects.map((p) => (
                    <SettingRow key={p.projectKey} setting={p} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </details>
    </span>
  );
}

function SettingRow({ setting }: { readonly setting: LogworkProjectSetting }) {
  const setHours = useSetProjectHours();
  const [value, setValue] = useState<string>(
    setting.expectedHoursPerDay === null ? '' : String(setting.expectedHoursPerDay),
  );

  const save = (): void => {
    const trimmed = value.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0 || parsed > 24)) return;
    setHours.mutate({ projectKey: setting.projectKey, expectedHoursPerDay: parsed });
  };

  return (
    <li className="row">
      <code>{setting.projectKey}</code>
      {setting.canEdit ? (
        <>
          <input
            className="input input--number"
            type="number"
            min={1}
            max={24}
            step={0.5}
            value={value}
            placeholder="default"
            aria-label={`Expected hours per day for ${setting.projectKey}`}
            onChange={(e) => setValue(e.target.value)}
          />
          <span className="muted">h</span>
          <button
            type="button"
            className="button button--icon"
            onClick={save}
            disabled={setHours.isPending}
          >
            Save
          </button>
        </>
      ) : (
        <span className="muted" title="Only this project’s PM or an admin can change this">
          {setting.expectedHoursPerDay === null ? 'default' : `${setting.expectedHoursPerDay}h`} 🔒
        </span>
      )}
    </li>
  );
}
