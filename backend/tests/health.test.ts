import { describe, it, expect } from 'vitest';
import { GET } from '../src/app/api/health/route';

describe('Health Endpoint', () => {
  it('returns ok status', async () => {
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.service).toBe('ansari-backend');
    expect(data.timestamp).toBeDefined();
  });

  it('returns valid ISO timestamp', async () => {
    const response = await GET();
    const data = await response.json();

    const timestamp = new Date(data.timestamp);
    expect(timestamp.toISOString()).toBe(data.timestamp);
  });
});
