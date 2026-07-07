'use client';

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';

const Charts = dynamic(() => import('./charts'), { ssr: false });

interface StatsData {
  summary: {
    total_users: number;
    new_users_24h: number;
    new_users_7d: number;
    new_users_30d: number;
    total_threads: number;
    total_messages: number;
    total_feedback: number;
  };
  time_series: {
    users_per_day: { date: string; count: number }[];
    threads_per_day: { date: string; web: number; legacy: number }[];
    messages_per_day: { date: string; user: number; assistant: number }[];
  };
  recent_messages: {
    id: string;
    thread_id: string;
    thread_name: string | null;
    role: string;
    content_preview: string;
    agent_name: string | null;
    source: string;
    created_at: string;
  }[];
  feedback_summary: {
    thumbs_up: number;
    thumbs_down: number;
    report: number;
  };
  generated_at: string;
}

type PageState = 'idle' | 'loading' | 'error' | 'ready';

export default function AdminAnalyticsPage() {
  const [state, setState] = useState<PageState>('idle');
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [data, setData] = useState<StatsData | null>(null);
  const [days, setDays] = useState(30);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const fetchStats = useCallback(async (jwt: string, daysParam: number) => {
    setState('loading');
    try {
      const res = await fetch(`/api/v2/admin/stats?days=${daysParam}&limit=50`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.status === 403) {
        setState('error');
        setError('Access denied — your account is not an admin');
        return;
      }
      if (!res.ok) {
        setState('error');
        setError(`Error: ${res.status}`);
        return;
      }
      const json = await res.json();
      setData(json);
      setState('ready');
    } catch {
      setState('error');
      setError('Failed to fetch stats');
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('loading');
    try {
      const res = await fetch('/api/v2/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setState('error');
        setError(res.status === 401 ? 'Invalid credentials' : `Login failed: ${res.status}`);
        return;
      }
      const json = await res.json();
      const jwt = json.access_token;
      setToken(jwt);
      await fetchStats(jwt, days);
    } catch {
      setState('error');
      setError('Login failed');
    }
  };

  const handleDaysChange = (newDays: number) => {
    setDays(newDays);
    if (token) fetchStats(token, newDays);
  };

  if (state === 'idle' || (state === 'error' && !token)) {
    return (
      <div style={styles.container}>
        <h1 style={styles.title}>Ansari Analytics Dashboard</h1>
        {state === 'error' && <div style={styles.errorBox}>{error}</div>}
        <form onSubmit={handleLogin} style={styles.loginForm}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={styles.input}
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            required
          />
          <button type="submit" style={styles.button}>Sign In</button>
        </form>
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div style={styles.container}>
        <h1 style={styles.title}>Ansari Analytics Dashboard</h1>
        <p>Loading...</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={styles.container}>
        <h1 style={styles.title}>Ansari Analytics Dashboard</h1>
        <div style={styles.errorBox}>{error}</div>
        <button onClick={() => { setState('idle'); setToken(''); }} style={styles.button}>Back to Login</button>
      </div>
    );
  }

  if (!data) return null;

  const { summary, time_series, recent_messages, feedback_summary } = data;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Ansari Analytics Dashboard</h1>
        <div style={styles.dateButtons}>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => handleDaysChange(d)}
              style={days === d ? { ...styles.dateBtn, ...styles.dateBtnActive } : styles.dateBtn}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div style={styles.cards}>
        <Card label="Total Users" value={summary.total_users.toLocaleString()} />
        <Card label="New Users" value={`${summary.new_users_24h} / ${summary.new_users_7d} / ${summary.new_users_30d}`} sub="24h / 7d / 30d" />
        <Card label="Total Threads" value={summary.total_threads.toLocaleString()} />
        <Card label="Total Messages" value={summary.total_messages.toLocaleString()} />
        <Card label="Feedback" value={`${feedback_summary.thumbs_up} / ${feedback_summary.thumbs_down} / ${feedback_summary.report}`} sub="up / down / report" />
      </div>

      <Charts timeSeries={time_series} />

      <h2 style={styles.sectionTitle}>Recent Messages</h2>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Time</th>
            <th style={styles.th}>Thread</th>
            <th style={styles.th}>Role</th>
            <th style={styles.th}>Content</th>
          </tr>
        </thead>
        <tbody>
          {recent_messages.map((msg, i) => (
            <tr key={msg.id} style={i % 2 === 0 ? styles.rowEven : styles.rowOdd}>
              <td style={styles.td}>{new Date(msg.created_at).toLocaleString()}</td>
              <td style={styles.td}>{msg.thread_name || 'Untitled'}</td>
              <td style={styles.td}>{msg.role}</td>
              <td style={styles.tdContent}>{msg.content_preview}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardLabel}>{label}</div>
      <div style={styles.cardValue}>{value}</div>
      {sub && <div style={styles.cardSub}>{sub}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 1200, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' },
  title: { fontSize: 24, fontWeight: 600, margin: 0 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  dateButtons: { display: 'flex', gap: 8 },
  dateBtn: { padding: '6px 16px', border: '1px solid #ccc', borderRadius: 4, background: '#fff', cursor: 'pointer', fontSize: 14 },
  dateBtnActive: { background: '#0070f3', color: '#fff', borderColor: '#0070f3' },
  cards: { display: 'flex', flexWrap: 'wrap' as const, gap: 16, marginBottom: 32 },
  card: { flex: '1 1 180px', padding: 20, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },
  cardLabel: { fontSize: 13, color: '#6b7280', marginBottom: 4 },
  cardValue: { fontSize: 28, fontWeight: 700 },
  cardSub: { fontSize: 11, color: '#9ca3af', marginTop: 4 },
  sectionTitle: { fontSize: 18, fontWeight: 600, marginBottom: 12 },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 14 },
  th: { textAlign: 'left' as const, padding: '10px 12px', borderBottom: '2px solid #e5e7eb', color: '#374151', fontWeight: 600 },
  td: { padding: '8px 12px', borderBottom: '1px solid #f3f4f6' },
  tdContent: { padding: '8px 12px', borderBottom: '1px solid #f3f4f6', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  rowEven: { background: '#fff' },
  rowOdd: { background: '#f9fafb' },
  loginForm: { display: 'flex', flexDirection: 'column' as const, gap: 12, maxWidth: 360, marginTop: 24 },
  input: { padding: '10px 14px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 },
  button: { padding: '10px 20px', background: '#0070f3', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, cursor: 'pointer' },
  errorBox: { padding: 12, background: '#fef2f2', color: '#991b1b', borderRadius: 6, marginBottom: 16, border: '1px solid #fecaca' },
};
