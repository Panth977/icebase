// ICEBASE_PG_URL set (npm run test:pg): every IceBase server a test starts keeps its data in
// Postgres. A ':memory:' server gets schemas of its own (dropped when it closes); one with a data
// directory uses this file's prefix, dropped after the file.
import { randomBytes } from 'node:crypto';
import { afterAll } from 'vitest';
import { dropPostgresSchemas } from '@panth977/icebase-cli/emulator';

const url = process.env.ICEBASE_PG_URL!;
const prefix = `ibt_${randomBytes(4).toString('hex')}_`;
process.env.ICEBASE_DATABASE_URL = url;
process.env.ICEBASE_DATABASE_PREFIX = prefix;

afterAll(async () => {
  await dropPostgresSchemas(url, prefix);
});
