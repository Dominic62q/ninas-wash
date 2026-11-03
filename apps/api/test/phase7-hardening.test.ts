import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ db, config });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('response headers', () => {
  it('stops browsers and proxies keeping a copy of any answer', async () => {
    for (const url of ['/api/health', '/api/auth/me', '/api/nothing-here']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });
});

describe('production settings', () => {
  const good = { NODE_ENV: 'production', DATABASE_URL: 'postgres://wash:s3cret-long-value@127.0.0.1:5432/niinas', WEB_ORIGIN: 'https://wash.example.com' };

  it('starts with real settings', () => {
    expect(loadConfig(good).WEB_ORIGIN).toEqual(['https://wash.example.com']);
  });

  it('refuses the development defaults', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL is not set.*WEB_ORIGIN is not set/);
  });

  it('refuses the development database password', () => {
    expect(() => loadConfig({ ...good, DATABASE_URL: 'postgres://niinas:niinas_dev@127.0.0.1:5433/niinas' })).toThrow(/development password/);
  });

  it('refuses an http address for the app', () => {
    expect(() => loadConfig({ ...good, WEB_ORIGIN: 'http://wash.example.com' })).toThrow(/https/);
  });

  it('does not mind the defaults while developing', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
  });
});
