import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import cronstrue from 'cronstrue';
import { api, type Schedule } from './api';

/** Capitalise the first character, e.g. "sonnet" → "Sonnet". */
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Human-readable cron, e.g. "0 6 * * 6" → "At 06:00 AM, only on Saturday". */
function humanCron(expr: string): string {
  try {
    return cronstrue.toString(expr, { verbose: false });
  } catch {
    return expr;
  }
}

/** Generic async-state wrapper so every view handles loading/error uniformly. */
function Async<T>({
  q,
  children,
}: {
  q: { isLoading: boolean; error: unknown; data: T | undefined };
  children: (data: T) => React.ReactNode;
}) {
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.error) return <p className="error">{String((q.error as Error).message ?? q.error)}</p>;
  if (!q.data) return null;
  return <>{children(q.data)}</>;
}

function Badge({ on, label }: { on: boolean; label?: string }) {
  return <span className={`badge ${on ? 'on' : 'off'}`}>{label ?? (on ? 'yes' : 'no')}</span>;
}

/** Centered modal dialog; closes on backdrop click or the × button. */
function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{title}</div>
            {subtitle && <div className="mono small">{subtitle}</div>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ChannelsView() {
  const q = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  return (
    <Async q={q}>
      {(d) => {
        const configured = d.channels.filter((c) => c.configured).length;
        return (
          <>
            <p className="muted">
              {d.channels.length} channels · {configured} configured ·{' '}
              {d.channels.length - configured} on defaults
            </p>
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>cwd</th>
                  <th>Model</th>
                  <th>Access</th>
                </tr>
              </thead>
              <tbody>
                {[...d.channels]
                  .sort(
                    (a, b) =>
                      Number(b.configured) - Number(a.configured) ||
                      a.name.localeCompare(b.name),
                  )
                  .map((c, i, arr) => {
                    const firstDefault = !c.configured && (i === 0 || arr[i - 1].configured);
                    return (
                      <Fragment key={c.id}>
                        {firstDefault && (
                          <tr className="group-row">
                            <td colSpan={4}>On defaults</td>
                          </tr>
                        )}
                        <tr className={c.configured ? '' : 'dim'}>
                          <td>#{c.name}</td>
                          <td className="mono small">{c.cwd ?? '—'}</td>
                          <td>
                            {c.model ? (
                              cap(c.model)
                            ) : (
                              <span className="small">{cap(d.defaultModel)}</span>
                            )}
                          </td>
                          <td>{c.access ? JSON.stringify(c.access) : '—'}</td>
                        </tr>
                      </Fragment>
                    );
                  })}
              </tbody>
            </table>
          </>
        );
      }}
    </Async>
  );
}

export function AutomationsView() {
  const q = useQuery({ queryKey: ['automations'], queryFn: api.automations });
  const [sel, setSel] = useState<Schedule | null>(null);
  return (
    <Async q={q}>
      {(d) => (
        <>
          <h3>Schedules ({d.schedules.length})</h3>
          <p className="caption">
            Run a prompt on a cron schedule, posting the result to a channel. Click a row to see its
            prompt.
          </p>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Enabled</th>
                <th>When</th>
                <th>Model</th>
              </tr>
            </thead>
            <tbody>
              {[...d.schedules].sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
                <tr key={s.name} className="clickable" onClick={() => setSel(s)}>
                  <td>
                    <div>{s.name}</div>
                    <div className="mono small">{s.channelLabel}</div>
                  </td>
                  <td>
                    <Badge on={s.enabled} />
                  </td>
                  <td>
                    <div>{humanCron(s.cron)}</div>
                    <div className="mono small">{s.cron}</div>
                  </td>
                  <td>
                    {s.model ? (
                      cap(s.model)
                    ) : (
                      <span className="small">{cap(d.defaultModel)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {sel && (
            <Modal
              title={sel.name}
              subtitle={`${sel.channelLabel} · ${humanCron(sel.cron)}`}
              onClose={() => setSel(null)}
            >
              <pre className="prompt">{sel.prompt}</pre>
            </Modal>
          )}

          <h3>Triggers ({d.triggers.length})</h3>
          <p className="caption">
            Fire when a message's text matches a pattern (top-level messages only) and respond in
            the same channel.
          </p>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Enabled</th>
                <th>Patterns</th>
                <th>Channels</th>
                <th>Cooldown</th>
              </tr>
            </thead>
            <tbody>
              {[...d.triggers].sort((a, b) => a.name.localeCompare(b.name)).map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>
                    <Badge on={t.enabled} />
                  </td>
                  <td className="small">{t.patterns.join(', ')}</td>
                  <td className="mono small">{t.channels.join(', ')}</td>
                  <td>{t.cooldown}s</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Mention triggers ({d.mention_triggers.length})</h3>
          <p className="caption">
            Fire when a specific user is @-mentioned (any channel, including thread replies) and
            forward a summary to a separate channel.
          </p>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Enabled</th>
                <th>User</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {[...d.mention_triggers].sort((a, b) => a.name.localeCompare(b.name)).map((m) => (
                <tr key={m.name}>
                  <td>{m.name}</td>
                  <td>
                    <Badge on={m.enabled} />
                  </td>
                  <td className="mono">{m.user}</td>
                  <td className="mono">{m.target_channel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Async>
  );
}

export function ProfilesView() {
  const q = useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
  return (
    <Async q={q}>
      {(d) => (
        <table>
          <thead>
            <tr>
              <th>Profile</th>
              <th>Active</th>
              <th>Service</th>
            </tr>
          </thead>
          <tbody>
            {d.profiles.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td>
                  <Badge on={p.active} label={p.active ? 'viewing' : '—'} />
                </td>
                <td>
                  <Badge on={p.running} label={p.running ? 'running' : 'stopped'} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Async>
  );
}

export function SessionsView() {
  const q = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
  return (
    <Async q={q}>
      {(d) => (
        <>
          <p className="muted">{d.sessions.length} sessions (newest first)</p>
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Thread</th>
                <th>Session</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {d.sessions.slice(0, 200).map((s) => (
                <tr key={`${s.channelId}:${s.threadTs}`}>
                  <td>{s.channelLabel}</td>
                  <td className="mono small">{s.threadTs}</td>
                  <td className="mono small">{s.sessionId.slice(0, 8)}…</td>
                  <td className="small">{s.updatedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Async>
  );
}

export function LogsView() {
  const [error, setError] = useState(false);
  const q = useQuery({ queryKey: ['logs', error], queryFn: () => api.logs(error) });
  return (
    <>
      <div className="row">
        <button className={error ? '' : 'active'} onClick={() => setError(false)}>
          custie.log
        </button>
        <button className={error ? 'active' : ''} onClick={() => setError(true)}>
          custie-error.log
        </button>
      </div>
      <Async q={q}>
        {(d) =>
          d.exists ? (
            <pre className="logs">{d.lines.join('\n')}</pre>
          ) : (
            <p className="muted">No log file at {d.file}</p>
          )
        }
      </Async>
    </>
  );
}
