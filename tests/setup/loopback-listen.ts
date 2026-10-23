/**
 * Loopback-only ephemeral ports for the Jest environment.
 *
 * Supertest starts each request's server with `http.createServer(app).listen(0)`,
 * which binds the wildcard address (`::`). A wildcard bind can be assigned a
 * port another process already holds on `127.0.0.1` — the kernel treats those
 * as different addresses — and an IPv4 client dialling `127.0.0.1` then reaches
 * that foreign service. The suite sees an unrelated 401/404/405, or a parse
 * error when the service is not HTTP, and the failing test moves between runs.
 *
 * Binding loopback explicitly makes the kernel pick a port that is free on
 * `127.0.0.1`, so the address the test dials is the address it bound.
 *
 * The bind has to be synchronous. Supertest reads `server.address().port`
 * immediately after `listen(0)`, and the public `listen(0, '127.0.0.1')` form
 * resolves the host through the asynchronous lookup path, leaving `address()`
 * null at that moment. `_listen2` is Node's synchronous bind primitive; the
 * public host form ends up there anyway. If a future Node removes it, the
 * patch falls back to the previous wildcard behaviour — and the regression in
 * `tests/loopback-listen.test.ts` fails loudly rather than flaking silently.
 *
 * Only the ephemeral-port forms are redirected. A caller that names a host,
 * a specific port, or a Unix socket path keeps exactly what it asked for.
 */

import net from 'net';

const LOOPBACK = '127.0.0.1';

interface PatchMarker {
  __lifechatLoopbackListen?: true;
}

/** Node's synchronous TCP bind, with the legacy signatures it accepts. */
type InternalListen = (
  this: net.Server,
  address: string,
  port: number,
  addressType: number,
  backlog: number,
) => void;

const proto = net.Server.prototype as typeof net.Server.prototype & PatchMarker;

if (!proto.__lifechatLoopbackListen) {
  const originalListen = proto.listen as (...args: unknown[]) => net.Server;
  const internalListen = (proto as unknown as { _listen2?: InternalListen })._listen2;

  const patchedListen = function patchedListen(this: net.Server, ...args: unknown[]): net.Server {
    if (!internalListen) return originalListen.apply(this, args);

    const bindLoopback = (
      backlog: number | undefined,
      callback: (() => void) | undefined,
    ): net.Server => {
      // `_listen2` emits 'listening' on next tick, so the callback is attached
      // before binding and fires exactly once, as the public form would.
      if (typeof callback === 'function') this.once('listening', callback);
      internalListen.call(this, LOOPBACK, 0, 4, backlog ?? 511);
      return this;
    };

    const [first] = args;

    // `listen(callback)` means "any ephemeral port", with no host given.
    if (typeof first === 'function') {
      return bindLoopback(undefined, first as () => void);
    }

    if (typeof first === 'number' && first === 0) {
      const rest = args.slice(1);
      const second = rest[0];
      // A string is an explicit host and an object is an options bag. A
      // function (callback), a number (backlog), or nothing means the host was
      // left to the runtime.
      const hostOmitted =
        rest.length === 0 ||
        typeof second === 'function' ||
        typeof second === 'number' ||
        second === undefined;
      if (hostOmitted) {
        const backlog = typeof second === 'number' ? second : undefined;
        const callback = rest.find((arg): arg is () => void => typeof arg === 'function');
        return bindLoopback(backlog, callback);
      }
    }

    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      const options = first as net.ListenOptions;
      if (options.port === 0 && options.host === undefined && options.path === undefined) {
        const callback = args.slice(1).find((arg): arg is () => void => typeof arg === 'function');
        return bindLoopback(options.backlog, callback);
      }
    }

    return originalListen.apply(this, args);
  };

  proto.listen = patchedListen as typeof proto.listen;
  proto.__lifechatLoopbackListen = true;
}
