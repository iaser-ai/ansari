import { describe, it, expect } from 'vitest';
import * as schemaModule from '../db/schema';
import { users, threads, messages, feedback, shares, preferences } from '../db/schema';

describe('Database Schema', () => {
  it('users table has required columns', () => {
    expect(users.id).toBeDefined();
    expect(users.email).toBeDefined();
    expect(users.firstName).toBeDefined();
    expect(users.lastName).toBeDefined();
    expect(users.source).toBeDefined();
    expect(users.registeredVia).toBeDefined();
    expect(users.systemKey).toBeDefined();
    expect(users.createdAt).toBeDefined();
    expect(users.updatedAt).toBeDefined();
  });

  it('users carries no credential, role or session column; tokens is not in the schema (spec 300)', () => {
    // The columns and the table stay in the database until the contract PR;
    // apps/api's code can no longer name them.
    const columns = Object.keys(users);
    for (const legacy of ['passwordHash', 'isAdmin', 'sessionVersion']) {
      expect(columns).not.toContain(legacy);
    }
    expect('tokens' in schemaModule).toBe(false);
  });

  it('threads table has required columns', () => {
    expect(threads.id).toBeDefined();
    expect(threads.userId).toBeDefined();
    expect(threads.name).toBeDefined();
    expect(threads.source).toBeDefined();
    expect(threads.client).toBeDefined();
    expect(threads.createdAt).toBeDefined();
    expect(threads.updatedAt).toBeDefined();
  });

  it('messages table has required columns', () => {
    expect(messages.id).toBeDefined();
    expect(messages.threadId).toBeDefined();
    expect(messages.role).toBeDefined();
    expect(messages.content).toBeDefined();
    expect(messages.agentName).toBeDefined();
    expect(messages.source).toBeDefined();
    expect(messages.client).toBeDefined();
    expect(messages.createdAt).toBeDefined();
  });

  it('feedback table has required columns', () => {
    expect(feedback.id).toBeDefined();
    expect(feedback.userId).toBeDefined();
    expect(feedback.threadId).toBeDefined();
    expect(feedback.messageId).toBeDefined();
    expect(feedback.feedbackClass).toBeDefined();
    expect(feedback.comment).toBeDefined();
    expect(feedback.createdAt).toBeDefined();
  });

  it('shares table has required columns', () => {
    expect(shares.id).toBeDefined();
    expect(shares.threadId).toBeDefined();
    expect(shares.content).toBeDefined();
    expect(shares.createdAt).toBeDefined();
  });

  it('preferences table has required columns', () => {
    expect(preferences.userId).toBeDefined();
    expect(preferences.key).toBeDefined();
    expect(preferences.value).toBeDefined();
    expect(preferences.updatedAt).toBeDefined();
  });
});
