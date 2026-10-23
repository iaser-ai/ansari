import {describe} from 'node:test';
import {defineParityCases} from './parity-cases.ts';

// The Node/Docker artifact (dist/server/index.js) as a child process. Its signal lifecycle stays in lifecycle.test.ts.
describe('Node runtime', () => defineParityCases('node'));
