'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BandError,
  BandRegistry,
  ReportService,
  bucketIndex,
  validateBoundaries,
} = require('../lib/bands');
const { OLD_BOUNDARIES, DEFAULT_NEW_BOUNDARIES, sampleTransactions } = require('../lib/sample-data');

function freshService() {
  const registry = new BandRegistry();
  registry.publish(OLD_BOUNDARIES); // v1
  const service = new ReportService(registry);
  service.addTransactions(sampleTransactions());
  return { registry, service };
}

const counts = (summary) => summary.buckets.map((b) => b.count);

// ---------- 正常：半开区间分桶，边界相等只进一个桶 ----------

test('bucketIndex: 边界价格落入以它为下界的桶，且仅一个桶', () => {
  const b = [1000, 2000, 5000];
  assert.equal(bucketIndex(b, 999), 0);
  assert.equal(bucketIndex(b, 1000), 1); // 等于下界 -> [1000,2000)
  assert.equal(bucketIndex(b, 1999), 1);
  assert.equal(bucketIndex(b, 2000), 2);
  assert.equal(bucketIndex(b, 5000), 3);
  assert.equal(bucketIndex(b, 8000), 3);
});

test('旧价带 v1 汇总（优惠前）：边界交易各进一桶，总数守恒', () => {
  const { service } = freshService();
  const s = service.summarize({ versionId: 'v1', basis: 'gross' });
  assert.deepEqual(counts(s), [1, 5, 4, 2]);
  assert.equal(s.total, 12);
  // 边界单 T02(1000) 在桶 1 而非桶 0；T09(5000) 在桶 3 而非桶 2
  const boundary = service.boundaryTransactions({ versionId: 'v1', basis: 'gross' });
  const byId = Object.fromEntries(boundary.transactions.map((t) => [t.id, t.bucketIndex]));
  assert.deepEqual(byId, { T02: 1, T03: 1, T06: 2, T07: 2, T09: 3 });
  // 边界单各自只出现一次
  assert.equal(boundary.transactions.length, 5);
});

test('口径切换（优惠前/后）结果不同，且不会错误复用旧汇总', () => {
  const { service } = freshService();
  const gross1 = service.summarize({ versionId: 'v1', basis: 'gross' });
  const net = service.summarize({ versionId: 'v1', basis: 'net' });
  assert.deepEqual(counts(gross1), [1, 5, 4, 2]);
  assert.deepEqual(counts(net), [2, 5, 4, 1]); // 优惠后有单跨桶
  // 切到 net 必须重新计算（缓存未命中），不能复用 gross 的汇总
  assert.equal(service.stats.summaryMiss, 2);
  assert.equal(service.stats.summaryHit, 0);
  // 切回 gross：命中缓存且数值与首次一致
  const gross2 = service.summarize({ versionId: 'v1', basis: 'gross' });
  assert.equal(service.stats.summaryHit, 1);
  assert.deepEqual(counts(gross2), counts(gross1));
});

test('分粒度中间结果可跨价带版本复用，但汇总按版本各自重算', () => {
  const { registry, service } = freshService();
  service.summarize({ versionId: 'v1', basis: 'gross' });
  assert.deepEqual(
    { h: service.stats.histogramMiss, s: service.stats.summaryMiss },
    { h: 1, s: 1 },
  );
  registry.publish(DEFAULT_NEW_BOUNDARIES); // v2
  const s2 = service.summarize({ versionId: 'v2', basis: 'gross' });
  assert.deepEqual(counts(s2), [3, 5, 4]);
  // 直方图（分粒度中间结果）命中复用，汇总按新版本重算
  assert.equal(service.stats.histogramHit, 1);
  assert.equal(service.stats.histogramMiss, 1);
  assert.equal(service.stats.summaryMiss, 2);
});

test('逐单重算（raw）与缓存路径结果一致', () => {
  const { registry, service } = freshService();
  registry.publish(DEFAULT_NEW_BOUNDARIES);
  for (const versionId of ['v1', 'v2']) {
    for (const basis of ['gross', 'net']) {
      const cached = service.summarize({ versionId, basis, mode: 'cached' });
      const raw = service.summarize({ versionId, basis, mode: 'raw' });
      assert.deepEqual(counts(raw), counts(cached), `${versionId}/${basis}`);
      assert.equal(raw.total, 12);
    }
  }
});

test('去年报表保留旧边界：发布新价带后留档报表不变，旧版本仍可重算', () => {
  const { registry, service } = freshService();
  const oldReport = service.generateReport({ versionId: 'v1', basis: 'gross' });
  registry.publish(DEFAULT_NEW_BOUNDARIES); // v2
  service.generateReport({ versionId: 'v2', basis: 'gross' });

  const archived = service.getReport(oldReport.id);
  assert.deepEqual(archived.boundaries, OLD_BOUNDARIES);
  assert.deepEqual(counts(archived), [1, 5, 4, 2]);

  const recomputed = service.summarize({ versionId: 'v1', basis: 'gross' });
  assert.deepEqual(counts(recomputed), counts(archived));
  assert.deepEqual(recomputed.boundaries, OLD_BOUNDARIES);
});

test('数据变更后缓存失效，汇总反映新数据', () => {
  const { service } = freshService();
  const before = service.summarize({ versionId: 'v1', basis: 'gross' });
  assert.deepEqual(counts(before), [1, 5, 4, 2]);
  service.addTransactions([{ id: 'T13', grossCents: 1000, discountCents: 0 }]);
  const after = service.summarize({ versionId: 'v1', basis: 'gross' });
  assert.deepEqual(counts(after), [1, 6, 4, 2]);
  assert.equal(after.total, 13);
  assert.equal(service.stats.summaryMiss, 2);
  assert.equal(service.stats.summaryHit, 0);
});

// ---------- 异常：非法输入必须被拒绝 ----------

test('发布非法边界被拒绝', () => {
  const bad = [
    undefined, null, '1000', [], // 非数组 / 空数组
    [1000, 1000], // 相邻相等
    [2000, 1000], // 非递增
    [1000.5], // 非整数
    [-5], // 负数
    [1000, 'x'], // 非数字
  ];
  for (const b of bad) {
    assert.throws(() => validateBoundaries(b), (err) => {
      assert.ok(err instanceof BandError);
      assert.equal(err.code, 'INVALID_BOUNDARIES');
      return true;
    }, `boundaries=${JSON.stringify(b)}`);
  }
});

test('非法计价口径 / 未知价带版本 / 未知计算方式被拒绝', () => {
  const { service } = freshService();
  assert.throws(
    () => service.summarize({ versionId: 'v1', basis: 'afterDiscount' }),
    { code: 'INVALID_BASIS' },
  );
  assert.throws(
    () => service.summarize({ versionId: 'v99', basis: 'gross' }),
    { code: 'UNKNOWN_VERSION' },
  );
  assert.throws(
    () => service.summarize({ versionId: 'v1', basis: 'gross', mode: 'magic' }),
    { code: 'INVALID_MODE' },
  );
  assert.throws(
    () => service.boundaryTransactions({ versionId: 'v1', basis: 'list' }),
    { code: 'INVALID_BASIS' },
  );
});

test('非法交易被拒绝（负价、非整数、优惠超过成交价、缺 id）', () => {
  const { service } = freshService();
  const bad = [
    [{ id: 'X1', grossCents: -1, discountCents: 0 }],
    [{ id: 'X2', grossCents: 10.5, discountCents: 0 }],
    [{ id: 'X3', grossCents: 100, discountCents: 101 }],
    [{ grossCents: 100, discountCents: 0 }],
    [],
  ];
  for (const batch of bad) {
    assert.throws(() => service.addTransactions(batch), { code: 'INVALID_TRANSACTION' });
  }
  // 全部拒绝后数据不变
  assert.equal(service.transactions.length, 12);
});

test('未知留档报表被拒绝', () => {
  const { service } = freshService();
  assert.throws(() => service.getReport('r999'), { code: 'UNKNOWN_REPORT' });
});
