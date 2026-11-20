'use strict';

/**
 * 仅使用 Node.js 内置模块的 HTTP 服务。
 * 启动：node server.js（读取 PORT 环境变量，默认 3000，绑定 127.0.0.1）
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { BandRegistry, ReportService, BandError } = require('./lib/bands');
const { OLD_BOUNDARIES, sampleTransactions } = require('./lib/sample-data');

const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
const MAX_BODY_BYTES = 1024 * 1024;

/** 初始应用状态：发布旧价带 v1 并灌入合成样例。 */
function createApp() {
  const registry = new BandRegistry();
  registry.publish(OLD_BOUNDARIES); // v1：去年报表沿用的旧边界
  const service = new ReportService(registry);
  service.addTransactions(sampleTransactions());
  return { registry, service };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, code) {
  sendJson(res, status, { error: message, code });
}

function statusOf(err) {
  if (err instanceof BandError) {
    if (err.code.startsWith('INVALID_')) return 400;
    if (err.code.startsWith('UNKNOWN_')) return 404;
    return 400;
  }
  return 500;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BandError('request body too large', 'INVALID_BODY'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BandError('request body is not valid JSON', 'INVALID_BODY');
  }
}

function appState(app) {
  const { registry, service } = app;
  return {
    transactionCount: service.transactions.length,
    dataVersion: service.dataVersion,
    versions: registry.list(),
    currentVersionId: registry.current().id,
    reports: service.listReports().map((r) => ({
      id: r.id,
      versionId: r.versionId,
      basis: r.basis,
      mode: r.mode,
      total: r.total,
      createdAt: r.createdAt,
    })),
    cacheStats: { ...service.stats },
  };
}

async function route(req, res, getApp, setApp) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;
  const method = req.method;

  // 页面
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = await fs.promises.readFile(INDEX_HTML);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 状态
  if (method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, appState(getApp()));
    return;
  }

  // 重置为合成样例（便于页面上反复操作）
  if (method === 'POST' && pathname === '/api/reset') {
    setApp(createApp());
    sendJson(res, 200, appState(getApp()));
    return;
  }

  // 生成报表：{ versionId, basis, mode? }
  if (method === 'POST' && pathname === '/api/reports') {
    const body = await readJsonBody(req);
    const report = getApp().service.generateReport({
      versionId: body.versionId,
      basis: body.basis,
      mode: body.mode === undefined ? 'cached' : body.mode,
    });
    sendJson(res, 201, report);
    return;
  }

  // 查看留档报表（去年报表保留旧边界）
  const reportMatch = pathname.match(/^\/api\/reports\/([^/]+)$/);
  if (method === 'GET' && reportMatch) {
    sendJson(res, 200, getApp().service.getReport(decodeURIComponent(reportMatch[1])));
    return;
  }

  // 发布新价带：{ boundaries: [...] }
  if (method === 'POST' && pathname === '/api/bands/publish') {
    const body = await readJsonBody(req);
    const version = getApp().registry.publish(body.boundaries);
    sendJson(res, 201, version);
    return;
  }

  // 查看边界交易：?versionId=v1&basis=gross
  if (method === 'GET' && pathname === '/api/boundary-transactions') {
    const versionId = url.searchParams.get('versionId');
    const basis = url.searchParams.get('basis');
    if (!versionId || !basis) {
      throw new BandError('query params versionId and basis are required', 'INVALID_QUERY');
    }
    sendJson(res, 200, getApp().service.boundaryTransactions({ versionId, basis }));
    return;
  }

  sendError(res, 404, `not found: ${method} ${pathname}`, 'NOT_FOUND');
}

function createServer() {
  let app = createApp();
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, () => app, (next) => { app = next; });
    } catch (err) {
      const status = statusOf(err);
      if (status >= 500) console.error(err);
      sendError(res, status, err.message, err.code || 'INTERNAL');
    }
  });
  server.app = () => app;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`price-band service listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer, createApp };
