/**
 * Proof for the loopback bind in `tests/setup/loopback-listen.ts`.
 *
 * The flake this prevents: supertest starts a server with `listen(0)`, the
 * wildcard address lets the kernel hand out a port another process already
 * holds on `127.0.0.1`, and the test's IPv4 request is answered by that foreign
 * service (a 401/404/405, or a parse error). If the setup stops binding
 * loopback, `listen(0)` binds `::` again and the first two assertions fail.
 */

import http from 'http';
import net from 'net';

type Listen = (...args: unknown[]) => net.Server;

/** Resolves with the bound TCP address once the callback fires. */
function listen(server: net.Server, ...args: unknown[]): Promise<net.AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    (server.listen as unknown as Listen)(...args, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`expected a TCP address, got ${String(address)}`));
        return;
      }
      resolve(address);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function get(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/' }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('Jest ephemeral servers bind 127.0.0.1', () => {
  it('binds the bare listen(0) form to loopback', async () => {
    const server = net.createServer();
    try {
      const address = await listen(server, 0);
      expect(address.address).toBe('127.0.0.1');
      expect(address.port).toBeGreaterThan(0);
    } finally {
      await close(server);
    }
  });

  it('binds the callback-only form to loopback', async () => {
    const server = net.createServer();
    try {
      const address = await listen(server);
      expect(address.address).toBe('127.0.0.1');
    } finally {
      await close(server);
    }
  });

  it('binds the options form to loopback', async () => {
    const server = net.createServer();
    try {
      const address = await listen(server, { port: 0 });
      expect(address.address).toBe('127.0.0.1');
    } finally {
      await close(server);
    }
  });

  it('binds an http.Server — the shape supertest constructs — to loopback', async () => {
    const server = http.createServer((_request, response) => response.end('own-app'));
    try {
      const address = await listen(server);
      expect(address.address).toBe('127.0.0.1');
      await expect(get(address.port)).resolves.toEqual({ status: 200, body: 'own-app' });
    } finally {
      await close(server);
    }
  });

  it('keeps an explicit host, so a caller can still choose the wildcard', async () => {
    const server = net.createServer();
    try {
      const address = await listen(server, 0, '::');
      expect(address.address).toBe('::');
    } finally {
      await close(server);
    }
  });

  it('never shares a port with a service already listening on loopback', async () => {
    // The miniature of the original failure: a foreign service holds an IPv4
    // loopback port and answers 401. A wildcard-bound test server could be
    // handed the same port and the client would reach the foreign service.
    const foreign = net.createServer((socket) => {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    });
    const app = http.createServer((_request, response) => response.end('own-app'));
    try {
      const foreignAddress = await listen(foreign);
      const appAddress = await listen(app);
      expect(appAddress.port).not.toBe(foreignAddress.port);
      await expect(get(appAddress.port)).resolves.toEqual({ status: 200, body: 'own-app' });
    } finally {
      await close(app);
      await close(foreign);
    }
  });
});
