'use strict';

/**
 * 价带（price band）核心领域逻辑。
 *
 * - 成交价一律以「分」（整数）保存，绝不出现浮点。
 * - 价带规则独立发布，带版本号；历史报表按生成时的版本留档，永不回写。
 * - 分桶采用半开区间 [lo, hi)：价格恰好等于边界的交易只落入
 *   「以该边界为下界」的那一个桶，不会重复计数。
 * - 汇总支持两种路径：
 *     cached —— 先按分粒度聚合成直方图（中间结果，可跨价带版本复用），再归桶；
 *     raw    —— 逐单重算，不碰任何缓存。
 * - 缓存键 = 数据版本 : 计价口径(gross/net) : 价带版本。
 *   口径从「优惠前」切到「优惠后」（或反之）时键必然变化，
 *   因此不会错误复用旧汇总；数据变更则整体失效。
 */

const VALID_BASES = new Set(['gross', 'net']);

class BandError extends Error {
  constructor(message, code = 'BAND_ERROR') {
    super(message);
    this.name = 'BandError';
    this.code = code;
  }
}

function assertBasis(basis) {
  if (!VALID_BASES.has(basis)) {
    throw new BandError(
      `invalid price basis: ${JSON.stringify(basis)} (expected "gross" or "net")`,
      'INVALID_BASIS',
    );
  }
}

function validateBoundaries(boundaries) {
  if (!Array.isArray(boundaries) || boundaries.length === 0) {
    throw new BandError('boundaries must be a non-empty array of integer cents', 'INVALID_BOUNDARIES');
  }
  let prev = -1;
  for (const b of boundaries) {
    if (!Number.isInteger(b) || b < 0) {
      throw new BandError(`boundary must be a non-negative integer (cents), got: ${JSON.stringify(b)}`, 'INVALID_BOUNDARIES');
    }
    if (b <= prev) {
      throw new BandError('boundaries must be strictly ascending', 'INVALID_BOUNDARIES');
    }
    prev = b;
  }
}

function validateTransaction(tx) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
    throw new BandError('transaction must be an object', 'INVALID_TRANSACTION');
  }
  if (typeof tx.id !== 'string' || tx.id.length === 0) {
    throw new BandError('transaction id must be a non-empty string', 'INVALID_TRANSACTION');
  }
  for (const field of ['grossCents', 'discountCents']) {
    if (!Number.isInteger(tx[field]) || tx[field] < 0) {
      throw new BandError(`transaction ${field} must be a non-negative integer (cents)`, 'INVALID_TRANSACTION');
    }
  }
  if (tx.discountCents > tx.grossCents) {
    throw new BandError('discountCents must not exceed grossCents', 'INVALID_TRANSACTION');
  }
}

/** 按口径取价：gross=优惠前，net=优惠后。单位：分。 */
function priceOf(tx, basis) {
  return basis === 'net' ? tx.grossCents - tx.discountCents : tx.grossCents;
}

/**
 * 半开区间分桶：(-∞,b0), [b0,b1), …, [bn,+∞)。
 * 返回「<= price 的边界个数」，价格等于边界时归入以它为下界的桶，
 * 因此任一价格有且仅有一个桶。
 */
function bucketIndex(boundaries, priceCents) {
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid] <= priceCents) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bucketLabel(boundaries, index) {
  const lo = index === 0 ? null : boundaries[index - 1];
  const hi = index === boundaries.length ? null : boundaries[index];
  if (lo === null && hi === null) return '(全部)';
  if (lo === null) return `< ${hi}`;
  if (hi === null) return `>= ${lo}`;
  return `[${lo}, ${hi})`;
}

/** 价带注册表：规则独立发布，版本只增不减，发布后不可变。 */
class BandRegistry {
  constructor() {
    this.versions = new Map();
    this.seq = 0;
  }

  publish(boundaries) {
    validateBoundaries(boundaries);
    this.seq += 1;
    const id = `v${this.seq}`;
    const version = Object.freeze({
      id,
      boundaries: Object.freeze([...boundaries]),
      publishedAt: new Date().toISOString(),
    });
    this.versions.set(id, version);
    return version;
  }

  get(id) {
    const v = this.versions.get(id);
    if (!v) throw new BandError(`unknown band version: ${JSON.stringify(id)}`, 'UNKNOWN_VERSION');
    return v;
  }

  current() {
    if (this.seq === 0) throw new BandError('no band version published yet', 'UNKNOWN_VERSION');
    return this.versions.get(`v${this.seq}`);
  }

  list() {
    return [...this.versions.values()];
  }
}

class ReportService {
  constructor(registry) {
    this.registry = registry;
    this.transactions = [];
    this.dataVersion = 0;
    // 分粒度中间结果缓存：key = dataVersion:basis，值 = Map(分 -> 单数)
    this.histogramCache = new Map();
    // 汇总缓存：key = dataVersion:basis:bandVersion
    this.summaryCache = new Map();
    this.reports = new Map();
    this.reportSeq = 0;
    this.stats = { histogramHit: 0, histogramMiss: 0, summaryHit: 0, summaryMiss: 0 };
  }

  addTransactions(batch) {
    if (!Array.isArray(batch) || batch.length === 0) {
      throw new BandError('batch must be a non-empty array of transactions', 'INVALID_TRANSACTION');
    }
    for (const tx of batch) validateTransaction(tx);
    for (const tx of batch) {
      this.transactions.push({
        id: tx.id,
        grossCents: tx.grossCents,
        discountCents: tx.discountCents,
      });
    }
    this.dataVersion += 1;
    this.histogramCache.clear();
    this.summaryCache.clear();
  }

  /** 分粒度直方图（中间结果）：只随数据版本与口径变化，与价带版本无关。 */
  histogram(basis) {
    assertBasis(basis);
    const key = `${this.dataVersion}:${basis}`;
    const cached = this.histogramCache.get(key);
    if (cached) {
      this.stats.histogramHit += 1;
      return cached;
    }
    this.stats.histogramMiss += 1;
    const h = new Map();
    for (const tx of this.transactions) {
      const p = priceOf(tx, basis);
      h.set(p, (h.get(p) || 0) + 1);
    }
    this.histogramCache.set(key, h);
    return h;
  }

  /**
   * 生成某价带版本下的分桶汇总。
   * mode: 'cached' 用分粒度缓存中间结果；'raw' 逐单重算。
   */
  summarize({ versionId, basis, mode = 'cached' }) {
    assertBasis(basis);
    const version = this.registry.get(versionId);
    const { boundaries } = version;
    const emptyCounts = () => new Array(boundaries.length + 1).fill(0);

    if (mode === 'raw') {
      const counts = emptyCounts();
      for (const tx of this.transactions) {
        counts[bucketIndex(boundaries, priceOf(tx, basis))] += 1;
      }
      return this.#shape(version, basis, counts, 'raw');
    }
    if (mode !== 'cached') {
      throw new BandError(`unknown mode: ${JSON.stringify(mode)}`, 'INVALID_MODE');
    }

    const key = `${this.dataVersion}:${basis}:${version.id}`;
    const cached = this.summaryCache.get(key);
    if (cached) {
      this.stats.summaryHit += 1;
      return this.#shape(version, basis, cached, 'cached');
    }
    this.stats.summaryMiss += 1;
    const counts = emptyCounts();
    for (const [cents, n] of this.histogram(basis)) {
      counts[bucketIndex(boundaries, cents)] += n;
    }
    this.summaryCache.set(key, counts);
    return this.#shape(version, basis, counts, 'cached');
  }

  #shape(version, basis, counts, mode) {
    return {
      versionId: version.id,
      boundaries: [...version.boundaries],
      basis,
      mode,
      total: counts.reduce((a, b) => a + b, 0),
      buckets: counts.map((count, i) => ({
        index: i,
        label: bucketLabel(version.boundaries, i),
        count,
      })),
    };
  }

  /** 生成报表并留档：快照自带边界副本，之后发布新价带不影响它。 */
  generateReport({ versionId, basis, mode = 'cached' }) {
    const summary = this.summarize({ versionId, basis, mode });
    this.reportSeq += 1;
    const report = {
      id: `r${this.reportSeq}`,
      createdAt: new Date().toISOString(),
      ...summary,
      buckets: summary.buckets.map((b) => ({ ...b })),
    };
    this.reports.set(report.id, report);
    return report;
  }

  getReport(id) {
    const r = this.reports.get(id);
    if (!r) throw new BandError(`unknown report: ${JSON.stringify(id)}`, 'UNKNOWN_REPORT');
    return r;
  }

  listReports() {
    return [...this.reports.values()];
  }

  /** 价格恰好落在边界上的交易，各自标注唯一归属的桶。 */
  boundaryTransactions({ versionId, basis }) {
    assertBasis(basis);
    const version = this.registry.get(versionId);
    const onBoundary = new Set(version.boundaries);
    const out = [];
    for (const tx of this.transactions) {
      const price = priceOf(tx, basis);
      if (onBoundary.has(price)) {
        const idx = bucketIndex(version.boundaries, price);
        out.push({
          id: tx.id,
          grossCents: tx.grossCents,
          discountCents: tx.discountCents,
          basis,
          priceCents: price,
          bucketIndex: idx,
          bucketLabel: bucketLabel(version.boundaries, idx),
        });
      }
    }
    return {
      versionId: version.id,
      boundaries: [...version.boundaries],
      basis,
      transactions: out,
    };
  }
}

module.exports = {
  VALID_BASES,
  BandError,
  BandRegistry,
  ReportService,
  validateBoundaries,
  validateTransaction,
  priceOf,
  bucketIndex,
  bucketLabel,
};
