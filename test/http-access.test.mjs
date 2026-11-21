import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../index.js";

function mount(t, connection) {
  const home = mkdtempSync(join(tmpdir(), "muse-http-"));
  const routes = new Map();
  const cleanups = [];
  const services = {
    tools: { register() {} },
    webServer: { register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    } },
    connection,
  };
  const ctx = {
    get: (name) => services[name],
    inject(names, bind) { if (names.every((name) => services[name])) bind(ctx); },
    effect(start) { const stop = start(); if (stop) cleanups.push(stop); },
  };
  apply(ctx, { homeDir: home, autoRefreshQuotaSeconds: 0 });
  t.after(async () => {
    for (const stop of cleanups.reverse()) await stop();
    rmSync(home, { recursive: true, force: true });
  });
  return routes;
}

const base = "/plugins/dsh-muse-media";
const loopback = { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" };

test("HTTP routes only mount with a host access checker", (t) => {
  assert.equal(mount(t, undefined).size, 0);
  assert.equal(mount(t, {}).size, 0);
});

test("all HTTP routes honor the host decision before inspecting request data", async (t) => {
  const connection = { requestRejection: t.mock.fn() };
  const routes = mount(t, connection);
  assert.equal(routes.size, 4);
  for (const status of [401, 403]) {
    connection.requestRejection.mock.mockImplementation(() => status);
    for (const [path, handle] of routes) {
      const req = { method: path.endsWith("/action") ? "POST" : "GET", url: path,
        get headers() { assert.fail("plugin inspected a denied request"); } };
      const res = { setHeader() {}, end() { this.ended = true; } };
      await handle(req, res);
      assert.equal(res.statusCode, status, path);
      assert.equal(res.ended, true);
      assert.equal(connection.requestRejection.mock.calls.at(-1).arguments[0], req);
    }
  }
});

test("host approval preserves the quota route's additional loopback restriction", async (t) => {
  const connection = { requestRejection: t.mock.fn(() => undefined) };
  const handle = mount(t, connection).get(base + "/quota");
  for (const [socket, host, expected] of [
    [loopback, "127.0.0.1", 200],
    [{ localAddress: "192.0.2.1", remoteAddress: "192.0.2.1" }, "192.0.2.1", 403],
  ]) {
    const res = { setHeader() {}, end() {} };
    await handle({ method: "GET", url: base + "/quota", headers: { host }, socket }, res);
    assert.equal(res.statusCode, expected);
  }
  assert.equal(connection.requestRejection.mock.callCount(), 2);
});
