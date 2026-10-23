/**
 * Server-log redaction (M-06).
 *
 * A log line outlives the request, sits outside the record-encryption boundary,
 * and is retained on the platform's schedule. Nothing that carried visitor or
 * model text may reach one, so this suite asserts three layers:
 *
 *   1. the helpers — an error becomes `{name, code, status, type}`, a payload
 *      becomes a length and a hash, and only code-shaped strings are printed;
 *   2. the behaviour — logging a parser error whose message quotes a body does
 *      not reproduce the quote, and a malformed request is not logged at all;
 *   3. the source — no `console.*` call outside the operator-facing CLIs passes
 *      an error object, its `message`, or a validator `detail`.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

import request from 'supertest';

import {
  describeError,
  fingerprint,
  logServerError,
  safeCode,
  safeRequestPath,
} from '../src/observability/safe-log';
import { createApp } from '../src/app';

const ADDRESS = 'visitor@example.com';

describe('describeError', () => {
  it('keeps the identity of a failure and drops its text', () => {
    const error = Object.assign(new SyntaxError(`Unexpected token in "${ADDRESS}"`), {
      status: 400,
      type: 'entity.parse.failed',
    });

    const facts = describeError(error);

    expect(facts).toEqual({
      name: 'SyntaxError',
      status: 400,
      type: 'entity.parse.failed',
    });
    expect(JSON.stringify(facts)).not.toContain(ADDRESS);
  });

  it('keeps a system errno code and a status code', () => {
    const error = Object.assign(new Error('EACCES, open /data/lead-records.jsonl'), {
      code: 'EACCES',
      statusCode: 503,
    });

    expect(describeError(error)).toEqual({ name: 'Error', code: 'EACCES', status: 503 });
  });

  it('does not throw on a value that is not an Error', () => {
    expect(describeError('boom')).toEqual({ name: 'NonError:string' });
    expect(describeError(undefined)).toEqual({ name: 'NonError:undefined' });
  });
});

describe('fingerprint', () => {
  it('is stable, length-prefixed, and does not carry the text', () => {
    const value = `my email is ${ADDRESS}`;
    const print = fingerprint(value);

    expect(print).toBe(fingerprint(value));
    expect(print).toMatch(/^len=\d+ sha=[0-9a-f]{12}$/);
    expect(print).not.toContain(ADDRESS);
    expect(print).not.toContain('my email');
  });

  it('distinguishes different payloads of the same length', () => {
    expect(fingerprint('abcd')).not.toBe(fingerprint('abce'));
  });
});

describe('safeCode', () => {
  it('passes the client vocabulary and refuses everything else', () => {
    expect(safeCode('api_error_500')).toBe('api_error_500');
    expect(safeCode('timeout')).toBe('timeout');

    expect(safeCode('api_error_401: Incorrect API key sk-live-SECRET')).toBe('unrecognized');
    expect(safeCode(`${ADDRESS} is not valid JSON`)).toBe('unrecognized');
    expect(safeCode(undefined)).toBe('unrecognized');
  });
});

describe('safeRequestPath', () => {
  it('prints a route and hides a path segment that is not an id', () => {
    expect(safeRequestPath('/api/session/lpp_abc123/history')).toBe(
      '/api/session/lpp_abc123/history',
    );

    const masked = safeRequestPath(`/api/session/${ADDRESS}/history`);
    expect(masked).toMatch(/^unrecognized\(len=\d+ sha=[0-9a-f]{12}\)$/);
    expect(masked).not.toContain(ADDRESS);
  });
});

describe('logServerError', () => {
  it('writes one line of facts, never the error message', () => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    });

    try {
      logServerError(
        '[http] unhandled request error',
        Object.assign(new Error(`body was {"message":"${ADDRESS}"}`), {
          name: 'PayloadError',
          status: 500,
        }),
        { method: 'POST', path: safeRequestPath('/api/chat'), status: 500 },
      );
    } finally {
      spy.mockRestore();
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[http] unhandled request error');
    expect(lines[0]).toContain('"name":"PayloadError"');
    expect(lines[0]).toContain('"path":"/api/chat"');
    expect(lines[0]).not.toContain(ADDRESS);
    expect(lines[0]).not.toContain('body was');
  });
});

describe('request paths stay out of the log', () => {
  it('does not log a malformed body that quotes an address', async () => {
    const app = createApp();
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    });

    try {
      const res = await request(app)
        .post('/api/chat')
        .set('content-type', 'application/json')
        .send(`{"sessionId":"lpp_abcdefghijkl","message":"${ADDRESS}",}`);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid JSON body' });
    } finally {
      spy.mockRestore();
    }

    expect(lines.join('\n')).not.toContain(ADDRESS);
  });
});

/**
 * Operator-facing entry points print to the operator's own terminal, not to a
 * retained server log, and their messages are authored in this repository (a
 * log path, a usage line, a gate verdict). They are the only exceptions.
 */
const OPERATOR_FILES = new Set([
  'src/index.ts',
  'src/evaluation/persona-guardrail-gate.ts',
  'src/evaluation/verdict-gate.ts',
  'src/testing/flake-harness-cli.ts',
]);

function isOperatorFile(relative: string): boolean {
  return OPERATOR_FILES.has(relative) || relative.endsWith('-cli.ts');
}

function sourceFiles(dir: string, root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full, root));
    } else if (full.endsWith('.ts')) {
      found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return found;
}

/** Source with comments removed, so prose about logging is not scanned. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The top-level arguments of a call, splitting on commas outside brackets. */
function topLevelArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < args.length; i += 1) {
    const char = args[i];
    if (quote) {
      current += char;
      if (char === '\\') {
        current += args[i + 1] ?? '';
        i += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** The argument text of every console call in a file. */
function consoleCalls(source: string): string[] {
  const calls: string[] = [];
  const opener = /console\.(?:error|warn|log|info|debug)\(/g;
  source = stripComments(source);
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    let quote: string | null = null;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      index += 1;
    }
    calls.push(source.slice(match.index + match[0].length, index - 1));
  }
  return calls;
}

describe('log-redaction gate', () => {
  it('no request-path console call passes an error, its message, or a detail', () => {
    const root = path.join(__dirname, '..');
    const offenders: string[] = [];

    for (const relative of sourceFiles(path.join(root, 'src'), root)) {
      if (isOperatorFile(relative)) continue;
      const source = readFileSync(path.join(root, relative), 'utf8');
      for (const args of consoleCalls(source)) {
        const parts = topLevelArguments(args).map((part) => part.trim());
        // A whole argument that is an error object, or its stringification.
        const bareError = parts.some(
          (part) =>
            ['err', 'error', 'e', 'exception', 'cause', 'thrown'].includes(part) ||
            /^JSON\.stringify\(\s*(?:err|error)\s*\)$/.test(part),
        );
        // `.message` is never a safe argument; `.detail` is safe only when it
        // is reduced to a fingerprint first.
        const leaksText =
          parts.some((part) => /\.message\b/.test(part)) ||
          (args.includes('.detail') && !args.includes('fingerprint('));
        if (bareError || leaksText) {
          offenders.push(`${relative}: console.…(${args.trim().replace(/\s+/g, ' ')})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('finds the console calls it is meant to inspect', () => {
    // A gate that silently matches nothing would pass forever.
    const source = readFileSync(path.join(__dirname, '..', 'src/app.ts'), 'utf8');
    expect(consoleCalls(source).length).toBeGreaterThan(0);
  });
});
