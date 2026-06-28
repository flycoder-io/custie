import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from './api';

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
                  <th>Config</th>
                  <th>cwd</th>
                  <th>Model</th>
                  <th>Access</th>
                </tr>
              </thead>
              <tbody>
                {d.channels.map((c) => (
                  <tr key={c.id} className={c.configured ? '' : 'dim'}>
                    <td>
                      <div>#{c.name}</div>
                      <div className="mono small">{c.id}</div>
                    </td>
                    <td>
                      <span className={`badge ${c.configured ? 'on' : 'off'}`}>
                        {c.configured ? 'configured' : 'default'}
                      </span>
                    </td>
                    <td className="mono small">{c.cwd ?? '—'}</td>
                    <td>{c.model ?? '—'}</td>
                    <td>{c.access ? JSON.stringify(c.access) : '—'}</td>
                  </tr>
                ))}
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
  return (
    <Async q={q}>
      {(d) => (
        <>
          <h3>Schedules ({d.schedules.length})</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Enabled</th>
                <th>Cron</th>
                <th>Channel</th>
                <th>TZ</th>
                <th>Model</th>
              </tr>
            </thead>
            <tbody>
              {d.schedules.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>
                    <Badge on={s.enabled} />
                  </td>
                  <td className="mono small">{s.cron}</td>
                  <td className="mono">{s.channel}</td>
                  <td>{s.timezone ?? '—'}</td>
                  <td>{s.model ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Triggers ({d.triggers.length})</h3>
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
              {d.triggers.map((t) => (
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
              {d.mention_triggers.map((m) => (
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
                  <td className="mono">{s.channelId}</td>
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
