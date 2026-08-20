'use client';

import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

interface TimeSeriesProps {
  timeSeries: {
    users_per_day: { date: string; count: number }[];
    threads_per_day: { date: string; web: number; legacy: number }[];
    messages_per_day: { date: string; user: number; assistant: number }[];
  };
}

export default function Charts({ timeSeries }: TimeSeriesProps) {
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>New Users Per Day</h2>
      <div style={{ width: '100%', height: 300, marginBottom: 32 }}>
        <ResponsiveContainer>
          <LineChart data={timeSeries.users_per_day}>
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="count" name="Users" stroke="#0070f3" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Threads Per Day</h2>
      <div style={{ width: '100%', height: 300, marginBottom: 32 }}>
        <ResponsiveContainer>
          <AreaChart data={timeSeries.threads_per_day}>
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Area type="monotone" dataKey="web" name="Web" stackId="1" fill="#0070f3" stroke="#0070f3" />
            <Area type="monotone" dataKey="legacy" name="Legacy" stackId="1" fill="#94a3b8" stroke="#94a3b8" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Messages Per Day</h2>
      <div style={{ width: '100%', height: 300, marginBottom: 32 }}>
        <ResponsiveContainer>
          <AreaChart data={timeSeries.messages_per_day}>
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Area type="monotone" dataKey="user" name="User" stackId="1" fill="#0070f3" stroke="#0070f3" />
            <Area type="monotone" dataKey="assistant" name="Assistant" stackId="1" fill="#94a3b8" stroke="#94a3b8" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
