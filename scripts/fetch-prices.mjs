import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0';
const TIMEOUT_MS = 10000;

function loadSymbols() {
  const fromSecret = process.env.STOCK_SYMBOLS;
  if (fromSecret) {
    try {
      return JSON.parse(fromSecret);
    } catch (e) {
      throw new Error(`STOCK_SYMBOLS 비밀값이 올바른 JSON 이 아닙니다: ${e.message}`);
    }
  }

  try {
    const src = readFileSync(join(ROOT, 'scripts/symbols.js'), 'utf8');
    const mod = { exports: {} };
    new Function('module', 'exports', src)(mod, mod.exports);
    return mod.exports;
  } catch {
    throw new Error(
      '종목코드를 찾지 못했습니다. STOCK_SYMBOLS 비밀값을 등록하거나 scripts/symbols.js 를 두십시오.'
    );
  }
}

function loadPrevious() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'data/prices.json'), 'utf8'))?.prices ?? {};
  } catch {
    return {};
  }
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fromNaver({ scope, code }) {
  const base = scope === 'domestic' ? 'domestic/stock' : 'worldstock/stock';
  const data = await getJson(`https://polling.finance.naver.com/api/realtime/${base}/${code}`);
  const row = data?.datas?.[0];
  if (!row) throw new Error('빈 응답');

  const price = Number(String(row.closePrice).replace(/,/g, ''));
  if (!Number.isFinite(price) || price <= 0) throw new Error(`현재가 파싱 실패: ${row.closePrice}`);

  return {
    price,
    source: 'naver',
    marketStatus: row.marketStatus ?? null,
    tradedAt: row.localTradedAt ?? null,
    changeRate: row.fluctuationsRatio != null ? Number(row.fluctuationsRatio) : null,
  };
}

async function fromYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
  const meta = (await getJson(url))?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error('현재가 없음');

  return {
    price,
    source: 'yahoo',
    marketStatus: meta.marketState ?? null,
    tradedAt: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    changeRate: null,
  };
}

async function fromUpbit(market) {
  const row = (await getJson(`https://api.upbit.com/v1/ticker?markets=${market}`))?.[0];
  if (!row) throw new Error('빈 응답');

  const price = Number(row.trade_price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('현재가 없음');

  return {
    price,
    source: 'upbit',
    marketStatus: null,
    tradedAt: row.timestamp ? new Date(row.timestamp).toISOString() : null,
    changeRate: row.signed_change_rate != null ? Number(row.signed_change_rate) * 100 : null,
  };
}

async function fromBithumb(symbol) {
  const res = await getJson(`https://api.bithumb.com/public/ticker/${symbol}`);
  if (res?.status !== '0000') throw new Error(`응답 코드 ${res?.status}`);

  const price = Number(res.data?.closing_price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('현재가 없음');

  return {
    price,
    source: 'bithumb',
    marketStatus: null,
    tradedAt: res.data.date ? new Date(Number(res.data.date)).toISOString() : null,
    changeRate: res.data.fluctate_rate_24H != null ? Number(res.data.fluctate_rate_24H) : null,
  };
}

async function fetchOne(id, sym, prev) {
  const now = new Date().toISOString();

  const chain = sym.upbit
    ? [['업비트', () => fromUpbit(sym.upbit)], ['빗썸', () => fromBithumb(sym.bithumb)]]
    : [['네이버', () => fromNaver(sym.naver)], ['야후', () => fromYahoo(sym.yahoo)]];

  const errors = [];
  for (const [name, call] of chain) {
    try {
      const quote = await call();
      if (errors.length) console.warn(`[${id}] ${errors.join(' / ')} → ${name}로 조회`);
      return { ...quote, fetchedAt: now, stale: false };
    } catch (e) {
      errors.push(`${name} 실패(${e.message})`);
    }
  }

  const reason = errors.join(' / ');

  if (prev?.price != null) {
    console.warn(`[${id}] 조회 실패(${reason}) → 마지막 시세 유지 (${prev.fetchedAt ?? '시각 불명'})`);
    return { ...prev, stale: true, error: reason };
  }

  console.error(`[${id}] 조회 실패, 이어 쓸 값도 없음: ${reason}`);
  return { price: null, source: null, stale: false, error: reason };
}

const symbols = loadSymbols();
const previous = loadPrevious();
const ids = Object.keys(symbols);
const results = await Promise.all(ids.map((id) => fetchOne(id, symbols[id], previous[id])));

const prices = {};
ids.forEach((id, i) => (prices[id] = results[i]));

const fresh = results.filter((r) => !r.stale && r.price != null).length;
const shown = results.filter((r) => r.price != null).length;

if (fresh === 0) {
  console.error('새로 받아온 시세가 없습니다 — prices.json 을 그대로 둡니다.');
  process.exit(1);
}

const unchanged =
  ids.length === Object.keys(previous).length &&
  ids.every((id) => previous[id]?.price === prices[id].price);

if (unchanged) {
  console.log('시세 변동 없음 — prices.json 을 그대로 둡니다.');
  process.exit(0);
}

const payload = {
  updatedAt: new Date().toISOString(),
  prices,
};

writeFileSync(join(ROOT, 'data/prices.json'), JSON.stringify(payload, null, 2) + '\n');
console.log(`저장 완료 — 새 시세 ${fresh}건 / 표시 가능 ${shown}건 (전체 ${ids.length}종목)`);
for (const id of ids) {
  const r = prices[id];
  const mark = r.price == null ? '표시 불가' : r.stale ? '이전 시세 유지' : r.source;
  console.log(`  ${id}: ${r.price ?? '—'} (${mark})`);
}
