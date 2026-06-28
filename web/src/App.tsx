import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import {
  ChannelsView,
  AutomationsView,
  ProfilesView,
  SessionsView,
  LogsView,
} from './views';

const TABS = [
  { key: 'channels', label: 'Channels', el: <ChannelsView /> },
  { key: 'automations', label: 'Automations', el: <AutomationsView /> },
  { key: 'profiles', label: 'Profiles', el: <ProfilesView /> },
  { key: 'sessions', label: 'Sessions', el: <SessionsView /> },
  { key: 'logs', label: 'Logs', el: <LogsView /> },
] as const;

export function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('channels');
  const profile = useQuery({ queryKey: ['profile'], queryFn: api.profile });

  return (
    <div className="app">
      <header>
        <h1>Custie</h1>
        <span className="profile">profile: {profile.data?.profile ?? '…'}</span>
      </header>
      <nav>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main>{TABS.find((t) => t.key === tab)?.el}</main>
    </div>
  );
}
