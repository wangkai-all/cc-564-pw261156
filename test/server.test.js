'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

let server;
let base;

test.beforeEach(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterEach(() => new Promise((resolve) => server.close(resolve)));

const postJson = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

// ---------- 页面 ----------

test('GET / 返回页面，业务结果区带 data-evidence-result 属性', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-evidence-result/);
  assert.match(html, /生成旧价带汇总/);
  assert.match(html, /发布新边界/);
  assert.match(html, /查看边界交易/);
});

// ---------- 正常流程：旧汇总 -> 发布新边界 -> 新报表重算 -> 边界交易 ----------

test('生成旧价带汇总（v1），总数守恒', async () => {
  const res = await postJson('/api/reports', { versionId: 'v1', basis: 'gross' });
  assert.equal(res.status, 201);
  const report = await res.json();
  assert.equal(report.versionId, 'v1');
  assert.deepEqual(report.boundaries, [1000, 2000, 5000]);
  assert.deepEqual(report.buckets.map((b) => b.count), [1, 5, 4, 2]);
  assert.equal(report.total, 12);
});

test('发布新边界后按新规则重算，旧报表仍保留旧边界', async () => {
  const oldRes = await postJson('/api/reports', { versionId: 'v1', basis: 'gross' });
  const oldReport = await oldRes.json();

  const pubRes = await postJson('/api/bands/publish', { boundaries: [1500, 3000] });
  assert.equal(pubRes.status, 201);
  const version = await pubRes.json();
  assert.equal(version.id, 'v2');

  const newRes = await postJson('/api/reports', { versionId: 'v2', basis: 'gross' });
  const newReport = await newRes.json();
  assert.deepEqual(newReport.boundaries, [1500, 3000]);
  assert.deepEqual(newReport.buckets.map((b) => b.count), [3, 5, 4]);

  // 去年报表留档不变
  const archived = await (await fetch(`${base}/api/reports/${oldReport.id}`)).json();
  assert.deepEqual(archived.boundaries, [1000, 2000, 5000]);
  assert.deepEqual(archived.buckets.map((b) => b.count), [1, 5, 4, 2]);
});

test('口径切换不复用旧汇总：net 与 gross 结果不同', async () => {
  const gross = await (await postJson('/api/reports', { versionId: 'v1', basis: 'gross' })).json();
  const net = await (await postJson('/api/reports', { versionId: 'v1', basis: 'net' })).json();
  assert.deepEqual(gross.buckets.map((b) => b.count), [1, 5, 4, 2]);
  assert.deepEqual(net.buckets.map((b) => b.count), [2, 5, 4, 1]);
});

test('查看边界交易：每笔只归属一个桶', async () => {
  const res = await fetch(`${base}/api/boundary-transactions?versionId=v1&basis=gross`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.transactions.length, 5);
  const byId = Object.fromEntries(data.transactions.map((t) => [t.id, t.bucketIndex]));
  assert.deepEqual(byId, { T02: 1, T03: 1, T06: 2, T07: 2, T09: 3 });
});

// ---------- 异常流程 ----------

test('发布非法边界返回 400，且不产生新版本', async () => {
  for (const boundaries of [[2000, 1000], [1000, 1000], [], [1000.5], [-1], '1000']) {
    const res = await postJson('/api/bands/publish', { boundaries });
    assert.equal(res.status, 400, JSON.stringify(boundaries));
    const body = await res.json();
    assert.equal(body.code, 'INVALID_BOUNDARIES');
  }
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.versions.length, 1);
});

test('未知价带版本 404，非法口径 / 计算方式 400', async () => {
  let res = await postJson('/api/reports', { versionId: 'v99', basis: 'gross' });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'UNKNOWN_VERSION');

  res = await postJson('/api/reports', { versionId: 'v1', basis: 'afterDiscount' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'INVALID_BASIS');

  res = await postJson('/api/reports', { versionId: 'v1', basis: 'gross', mode: 'magic' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'INVALID_MODE');
});

test('边界交易查询缺少参数 400，未知版本 404', async () => {
  let res = await fetch(`${base}/api/boundary-transactions?versionId=v1`);
  assert.equal(res.status, 400);
  res = await fetch(`${base}/api/boundary-transactions?versionId=v9&basis=gross`);
  assert.equal(res.status, 404);
});

test('请求体不是合法 JSON 返回 400', async () => {
  const res = await postJson('/api/reports', '{not json');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'INVALID_BODY');
});

test('未知报表与未知路由返回 404', async () => {
  let res = await fetch(`${base}/api/reports/r999`);
  assert.equal(res.status, 404);
  res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});

test('重置后回到样例初始状态', async () => {
  await postJson('/api/bands/publish', { boundaries: [1500, 3000] });
  const res = await postJson('/api/reset', {});
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.versions.length, 1);
  assert.equal(state.transactionCount, 12);
  assert.equal(state.currentVersionId, 'v1');
});
