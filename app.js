async function loadPrices() {
  const res = await fetch(`data/prices.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`시세 파일을 읽지 못했습니다 (HTTP ${res.status})`);
  return res.json();
}

function calc(holdings, prices) {
  const items = holdings.map((h) => {
    const entry = prices?.[h.id];
    const now = entry?.price ?? null;
    const rate = now == null ? null : ((now - h.entryPrice) / h.entryPrice) * 100;

    return { ...h, now, rate, stale: entry?.stale === true, fetchedAt: entry?.fetchedAt ?? null };
  });

  const live = items.filter((i) => i.rate != null);
  const sorted = [...live].sort((a, b) => b.rate - a.rate);

  return {
    items,
    live,
    sorted,
    avg: live.length ? live.reduce((s, i) => s + i.rate, 0) / live.length : null,
    best: sorted[0] ?? null,
    worst: sorted[sorted.length - 1] ?? null,
    ups: live.filter((i) => i.rate > 0).length,
    downs: live.filter((i) => i.rate <= 0).length,
    stales: items.filter((i) => i.stale).length,
  };
}

const won = new Intl.NumberFormat('ko-KR');
const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function money(value, currency) {
  if (value == null) return '—';
  return currency === 'KRW' ? `${won.format(Math.round(value))}원` : `$${usd.format(value)}`;
}

function pct(rate) {
  if (rate == null) return '—';
  return `${rate > 0 ? '+' : rate < 0 ? '−' : ''}${Math.abs(rate).toFixed(2)}%`;
}

function tone(rate) {
  if (rate == null) return 'na';
  return rate > 0 ? 'up' : 'down';
}

function stamp(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const $ = (id) => document.getElementById(id);

function renderSummary(m, total) {
  $('avgReturn').textContent = pct(m.avg);
  $('avgNote').textContent =
    m.live.length === total ? `${total}종목` : `조회 ${total}종목 중 ${m.live.length}종목`;

  const fill = (nameId, valueId, item) => {
    $(nameId).textContent = item ? item.label : '—';
    const v = $(valueId);
    v.textContent = pct(item?.rate ?? null);
    v.className = `peak-value v-${tone(item?.rate ?? null)}`;
  };
  fill('bestName', 'bestValue', m.best);
  fill('worstName', 'worstValue', m.worst);

  $('tally').innerHTML =
    `<span class="tally-up">${m.ups}</span>` +
    `<span class="sep">/</span>` +
    `<span class="tally-down">${m.downs}</span>`;
}

function renderBars(m) {

  const maxAbs = Math.max(...m.live.map((i) => Math.abs(i.rate)), 1);
  const order = [...m.sorted, ...m.items.filter((i) => i.rate == null)];

  $('bars').innerHTML = order
    .map((i) => {
      const t = tone(i.rate);
      const width = i.rate == null ? 0 : (Math.abs(i.rate) / maxAbs) * 49;
      const fill =
        i.rate == null ? '' : `<span class="bar-fill ${t}" style="width:${width}%"></span>`;
      return `<li class="bar-row">
          <span class="bar-name">${i.label}</span>
          <span class="bar-track">${fill}</span>
          <span class="bar-value v-${t}">${pct(i.rate)}</span>
        </li>`;
    })
    .join('');
}

function renderDonut(m, total) {
  const C = 2 * Math.PI * 50;

  const n = total || 1;
  const GAP = 2;

  const seg = (el, count, offset) => {

    const gap = count === 0 || count === n ? 0 : GAP;
    const len = Math.max((C * count) / n - gap, 0);
    el.style.strokeDasharray = `${len} ${C - len}`;
    el.style.strokeDashoffset = `${-offset}`;
  };
  seg($('segUp'), m.ups, 0);
  seg($('segDown'), m.downs, (C * m.ups) / n);

  $('donutCap').textContent = `${total} ASSETS`;
  $('donutMain').textContent = m.live.length ? `수익 ${m.ups}종목` : '조회 실패';

  const rows = [
    ['dot-up', '수익', m.ups],
    ['dot-down', '손실', m.downs],
  ];
  if (m.live.length < total) rows.push(['dot-idle', '조회 실패', total - m.live.length]);

  $('legend').innerHTML = rows
    .map(
      ([dot, name, count]) =>
        `<li><span class="dot ${dot}"></span><span>${name}</span><span class="count">${count}</span></li>`
    )
    .join('');
}

function renderRows(m) {
  $('rows').innerHTML = m.items
    .map(
      (i) => `<tr>
        <td>
          <div class="name-cell">
            <span class="avatar" data-id="${i.id}">${i.id}</span>
            <div>
              <div class="name-main">${i.label}</div>
              <div class="name-sub">
                ${i.currency}${i.stale ? ' <span class="stale-tag">· 이전 시세</span>' : ''}
              </div>
            </div>
          </div>
        </td>
        <td class="num"><span class="price">${money(i.entryPrice, i.currency)}</span></td>
        <td class="num"><span class="price now${i.stale ? ' is-stale' : ''}"
            ${i.stale && i.fetchedAt ? `title="${stamp(i.fetchedAt)} 조회"` : ''}
            >${money(i.now, i.currency)}</span></td>
        <td class="num"><span class="pill ${tone(i.rate)}">${pct(i.rate)}</span></td>
      </tr>`
    )
    .join('');
}

async function main() {
  let payload = null;
  let failure = null;

  try {
    payload = await loadPrices();
  } catch (e) {
    failure = e.message;
  }

  const m = calc(HOLDINGS, payload?.prices);
  const total = HOLDINGS.length;

  renderSummary(m, total);
  renderBars(m);
  renderDonut(m, total);
  renderRows(m);

  const at = stamp(payload?.updatedAt);
  $('asOf').textContent = at ? `${at} 기준` : '시세 시각 확인 불가';

  const badge = $('srcBadge');
  if (failure || m.live.length === 0) {
    badge.textContent = '시세를 불러오지 못했습니다';
    badge.classList.add('is-error');
    if (failure) console.error(failure);
  } else if (m.live.length < total) {
    badge.textContent = `${total - m.live.length}종목 시세 없음`;
    badge.classList.add('is-error');
  } else if (m.stales > 0) {

    badge.textContent = `${m.stales}종목 이전 시세 표시 중`;
    badge.classList.add('is-warn');
  }
}

main();
