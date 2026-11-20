'use strict';

/**
 * 合成样例数据（单位：分）。
 *
 * 故意安排了一批「价格恰好等于边界」的交易：
 * - 旧价带 v1 边界 [1000, 2000, 5000]：T02/T03 压在 1000，T06/T07 压在 2000，T09 压在 5000；
 * - 新价带 v2 边界 [1500, 3000]：T04/T12 压在 1500，T11 压在 3000；
 * - T03/T06/T09/T12 带优惠，切到「优惠后」口径时会跨桶，
 *   用来验证口径切换不会错误复用旧汇总。
 */

const OLD_BOUNDARIES = [1000, 2000, 5000];
const DEFAULT_NEW_BOUNDARIES = [1500, 3000];

function sampleTransactions() {
  return [
    { id: 'T01', grossCents: 500, discountCents: 0 },
    { id: 'T02', grossCents: 1000, discountCents: 0 },
    { id: 'T03', grossCents: 1000, discountCents: 1 },
    { id: 'T04', grossCents: 1500, discountCents: 0 },
    { id: 'T05', grossCents: 1999, discountCents: 0 },
    { id: 'T06', grossCents: 2000, discountCents: 200 },
    { id: 'T07', grossCents: 2000, discountCents: 0 },
    { id: 'T08', grossCents: 4999, discountCents: 0 },
    { id: 'T09', grossCents: 5000, discountCents: 500 },
    { id: 'T10', grossCents: 8000, discountCents: 0 },
    { id: 'T11', grossCents: 3000, discountCents: 0 },
    { id: 'T12', grossCents: 1500, discountCents: 500 },
  ];
}

module.exports = { OLD_BOUNDARIES, DEFAULT_NEW_BOUNDARIES, sampleTransactions };
