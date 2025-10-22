// etf-00909.js — 00909 專用：週次獲利(浮動長條)+累積淨利 、KPI、最佳化明細、最後一筆買進顯示
// 版本：kpi-opt-v7-fix  (修正變數重複宣告/小拼寫，保留所有功能)
(function(){
  // ---------- 小工具 ----------
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m, bad=false) => { if (status) { status.textContent = m; status.style.color = bad ? '#c62828' : '#666'; } };
  const fmtInt = n => Math.round(n || 0).toLocaleString();
  const fmtPct = v => (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(2) + '%';
  const tsPretty = ts14 => `${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;
  const DAY_MS = 24*60*60*1000;

  const rateLabel = l => l==='Strong' ? 'Strong (強)' : (l==='Adequate' ? 'Adequate (可)' : 'Improve (弱)');
  const rateHtml = l => `<span class="${l==='Strong'?'rate-strong':(l==='Adequate'?'rate-adequate':'rate-improve')}">${rateLabel(l)}</span>`;

  // ---------- 參數 ----------
  const CFG = {
    symbol: '00909',
    bucket: 'reports',
    want: /00909/i,
    feeRate: 0.001425,
    taxRate: 0.001,
    minFee: 20,
    unitShares: 1000,
    rf: 0.00,
    initialCapital: 1_000_000,
    manifestPath: 'manifests/etf-00909.json'
  };
  const OPT = { capital: 1_000_000, unitShares: CFG.unitShares, ratio: [1,1,2] };

  // chips
  $('#feeRateChip').textContent = (CFG.feeRate * 100).toFixed(4) + '%';
  $('#taxRateChip').textContent = (CFG.taxRate * 100).toFixed(3) + '%';
  $('#minFeeChip').textContent = String(CFG.minFee);
  $('#unitChip').textContent = String(CFG.unitShares);
  $('#slipChip').textContent = '0';
  $('#rfChip').textContent = (CFG.rf * 100).toFixed(2) + '%';

  // ---------- Supabase ----------
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const sb = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    { global: { fetch: (u,o={}) => fetch(u,{...o, cache:'no-store'}) } }
  );
  const pubUrl = p => { const {data} = sb.storage.from(CFG.bucket).getPublicUrl(p); return data?.publicUrl || '#'; };

  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(CFG.bucket).list(p, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(error.message);
    return (data || []).map(it => ({ name: it.name, fullPath: p + it.name, updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0, size: it.metadata?.size || 0 }));
  }
  async function listCandidates(){
    const u = new URL(location.href);
    const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }
  const lastDateScore = name => {
    const m = String(name).match(/\b(20\d{6})\b/g);
    return m && m.length ? Math.max(...m.map(s => +s || 0)) : 0;
  };

  // 多編碼下載
  async function fetchText(url){
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const trials = ['big5','utf-8','utf-16le','utf-16be','windows-1252'];
    for (const enc of trials) {
      try {
        return new TextDecoder(enc).decode(buf).replace(/\ufeff/gi,'');
      } catch {}
    }
    return new TextDecoder('utf-8').decode(buf);
  }

  // ---------- 使用 etf-engine 回測 ----------
  function backtest(rows){ return window.ETF_ENGINE.backtest(rows, CFG); }

  // ---------- 週次圖（BUY/SELL 以 SELL 的 pnlFull 歸屬到該週） ----------
  let chWeekly = null;
  function weekStartDate(ms){
    const d = new Date(ms);
    const dow = (d.getUTCDay() + 6) % 7; // 週一=0
    const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    return s.toISOString().slice(0,10);
  }
  function buildWeeklyFromExecs(execs){
    const m = new Map(), order = [];
    for (const e of execs) {
      if (e.side !== 'SELL' || typeof e.pnlFull !== 'number') continue;
      const wk = weekStartDate(e.tsMs);
      if (!m.has(wk)) { m.set(wk, 0); order.push(wk); }
      m.set(wk, m.get(wk) + e.pnlFull);
    }
    const labels = order;
    const weekly = labels.map(wk => m.get(wk) || 0);
    const cum = [];
    let s = 0;
    for (const v of weekly) { s += v; cum.push(s); }
    return { labels, weekly, cum };
  }
  function renderWeeklyChart(execs){
    const box = $('#weeklyCard');
    const ctx = $('#chWeekly');
    if (!ctx) return;
    const W = buildWeeklyFromExecs(execs);
    if (!W.labels.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    const maxCum = Math.max(...W.cum, 0);
    const floatBars = [];
    let prev = 0;
    for (const c of W.cum) { floatBars.push([prev, c]); prev = c; }
    if (chWeekly) chWeekly.destroy();
    chWeekly = new Chart(ctx, {
      data: {
        labels: W.labels,
        datasets: [
          { type: 'bar',  label: '每週獲利（浮動長條）', data: floatBars, borderWidth: 1, backgroundColor: 'rgba(13,110,253,0.30)', borderColor: '#0d6efd' },
          { type: 'line', label: '累積淨利',             data: W.cum,      borderWidth: 2, borderColor: '#f43f5e', tension: 0.2, pointRadius: 0 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true } },
        parsing: { yAxisKey: undefined }, // 讓 [start,end] 浮動條生效
        scales: { y: { suggestedMin: 0, suggestedMax: Math.max(1, maxCum * 1.05) }, x: { ticks: { maxTicksLimit: 12 } } }
      }
    });
  }

  // ---------- 最後一筆買進（僅在有未平倉時顯示） ----------
  function renderLastOpenBuy(execs){
    const netShares = execs.reduce((acc,e) => acc + (e.side==='BUY' ? e.shares : -e.shares), 0);
    const bar = $('#lastBuyBar');
    if (netShares <= 0) { if (bar) bar.style.display = 'none'; return; }

    // 找最後一次 SELL 的時間戳，再往回找距今最近的 BUY（未被該 SELL 抵消）
    let lastSellTs = -1;
    for (const e of execs) if (e.side === 'SELL') lastSellTs = Math.max(lastSellTs, e.tsMs);

    let lastBuy = null;
    for (let i = execs.length - 1; i >= 0; i--) {
      const e = execs[i];
      if (e.side === 'BUY' && e.tsMs >= lastSellTs) { lastBuy = e; break; }
    }
    if (!bar) return;
    if (!lastBuy) { bar.style.display = 'none'; return; }

    bar.innerHTML = `最後一筆買進：<b>${tsPretty(lastBuy.ts)}</b>　成交價格 <b>${Number(lastBuy.price).toFixed(2)}</b>　成交數量 <b>${fmtInt(lastBuy.shares)}</b>`;
    bar.style.display = '';
  }

  // ---------- 最佳化交易（本金 100 萬；1/1/2；資金不足自動縮量；最後未平倉也保留 BUY 行） ----------
  function splitSegments(execs){
    const segs = [];
    let cur = [];
    for (const e of execs) { cur.push(e); if (e.side === 'SELL') { segs.push(cur); cur = []; } }
    if (cur.length) segs.push(cur); // 末段可能無 SELL
    return segs;
  }
  function fees(price, shares, isSell){
    const gross = price * shares;
    const fee   = Math.max(CFG.minFee, gross * CFG.feeRate);
    const tax   = isSell ? (gross * CFG.taxRate) : 0;
    return { gross, fee, tax };
  }
  function buyCostLots(price, lots){
    const shares = lots * OPT.unitShares;
    const f = fees(price, shares, false);
    return { cost: f.gross + f.fee, shares, f };
  }
  function buildOptimizedExecs(execs){
    const segs = splitSegments(execs), out = [];
    let cumPnlAll = 0;

    for (const seg of segs) {
      const buys = seg.filter(x => x.side === 'BUY');
      const sell = seg.find(x => x.side === 'SELL');
      if (!buys.length) continue;

      const p0 = buys[0].price;
      const one = buyCostLots(p0, 1).cost;
      let maxLotsTotal = Math.floor(OPT.capital / one);
      if (maxLotsTotal <= 0) continue;

      let q = Math.floor(maxLotsTotal / 4);
      if (q <= 0) q = 1;

      const n = Math.min(3, buys.length);
      const plan = [q, q, 2*q].slice(0, n);

      let remaining = OPT.capital, sharesHeld = 0, avgCost = 0, cumCost = 0;
      let unitCount = plan.reduce((a,b) => a + b, 0);

      for (let i=0;i<n;i++) {
        const b = buys[i];
        let lots = plan[i];
        const unitC = buyCostLots(b.price, 1).cost;
        let affordable = Math.floor(remaining / unitC);
        if (affordable <= 0) break;
        if (lots > affordable) lots = affordable;

        const bc = buyCostLots(b.price, lots);
        remaining -= bc.cost;
        cumCost   += bc.cost;

        const newAvg = (sharesHeld * avgCost + b.price * bc.shares) / (sharesHeld + bc.shares || 1);
        sharesHeld = sharesHeld + bc.shares;
        avgCost    = newAvg;

        out.push({
          side:'BUY', ts:b.ts, tsMs:b.tsMs, price:b.price, avgCost:newAvg, shares:bc.shares,
          buyAmount:bc.f.gross, sellAmount:0, fee:bc.f.fee, tax:0, cost:bc.cost, cumCost,
          pnlFull:null, retPctUnit:null, cumPnlFull:cumPnlAll
        });
      }

      if (sell && sharesHeld > 0) {
        const st = fees(sell.price, sharesHeld, true);
        const pnlFull = st.gross - cumCost - (st.fee + st.tax);
        const retPctUnit = (unitCount>0 && cumCost>0) ? (pnlFull / (cumCost / unitCount)) : null;
        cumPnlAll += pnlFull;

        out.push({
          side:'SELL', ts:sell.ts, tsMs:sell.tsMs, price:sell.price, avgCost, shares:sharesHeld,
          buyAmount:0, sellAmount:st.gross, fee:st.fee, tax:st.tax, cost:0, cumCost,
          pnlFull, retPctUnit, cumPnlFull:cumPnlAll
        });
      }
      // 若沒有 SELL，則只會留下 BUY 行—符合「顯示最近一筆買進」的需求
    }

    // 依時間排序，確保最新的 BUY/SELL 在表尾
    out.sort((a,b) => a.tsMs - b.tsMs);
    return out;
  }

  // ---------- KPI 門檻 & 計算 ----------
  const BANDS = {
    CAGR:{strong:0.15, adequate:0.05},
    MaxDD:{strong:-0.10, adequate:-0.25},
    Vol:{strong:0.20, adequate:0.35},
    Sharpe:{strong:1.0, adequate:0.5},
    Sortino:{strong:1.5, adequate:0.75},
    Calmar:{strong:1.0, adequate:0.3},
    PF:{strong:1.5, adequate:1.0},
    Hit:{strong:0.55, adequate:0.45},
    TU_days:{strong:45, adequate:120},
    Rec_days:{strong:45, adequate:90},
    MCL:{strong:5, adequate:10},
    Payoff:{strong:1.5, adequate:1.0},
    CostRatio:{strong:0.001, adequate:0.003},
    Turnover:{strong:1.0, adequate:2.0},
    RtVol:{strong:1.0, adequate:0.5},
    MAR:{strong:1.0, adequate:0.3},
    Omega:{strong:1.5, adequate:1.0},
    VaR95:{strong:-0.02, adequate:-0.04},
    CVaR95:{strong:-0.03, adequate:-0.06},
    UI:{strong:0.05, adequate:0.12},
    Martin:{strong:0.8, adequate:0.3},
    GPR:{strong:1.5, adequate:1.0},
    Tail:{strong:1.5, adequate:1.0},
  };
  const rateHigher = (v,b) => v >= b.ko ? 'Strong' : (v >= b.adequate ? 'Adequate' : 'Improve'); // not used directly
  const rateLower  = (v,b) => v <= b.strong ? 'Strong' : (v <= b.adequate ? 'Adequate' : 'Improve');

  function computeKPIFromOpt(optExecs){
    if (!optExecs.length) return null;

    let equity = OPT.perfStart || OPT.capital;
    const timeline = [];
    const tradePnls = [];
    const tradeFees = [];
    const tradeTaxes = [];
    let grossBuy = 0, grossSell = 0;

    for (const e of optExecs) {
      if (e.side === 'BUY') {
        equity   -= (e.cost || 0);
        grossBuy += (e.buyAmount || 0);
      } else {
        equity   += (e.sellAmount || 0) - (e.fee || 0) - (e.tax || 0);
        if (typeof e.pnl == 'number') { /* none */ }
        if (typeof e.pnlFull === 'number') tradePnls.push(e.pnlFull);
        tradeFees.push(e.fee || 0);
        tradeTaxes.push(e.tax || 0);
        grossSell += (e.sellAmount || 0);
      }
      timeline.push({ t: e.tsMs, eq: equity });
    }

    // 日末合併
    const byDay = new Map();
    for (const p of timeline) {
      const d = new Date(p.t).toISOString().slice(0,10);
      byDay.set(d, p.eq);
    }
    const days = [...byDay.keys()].sort();
    const eqs  = days.map(d => byDay.get(d));
    const rets = [];
    for (let i=1;i<eqs.length;i++) {
      const a = eqs[i-1], b = eqs[i];
      if (a > 0) rets.push(b/a - 1);
    }

    const t0 = new Date(days[0]).getTime();
    const t1 = new Date(days.at(-1)).getTime();
    const years    = Math.max(1/365, (t1 - t0) / (365*DAY_MS));
    const totalRet = (eqs.at(-1) / OPT.capital) - 1;
    const CAGR     = Math.pow(1 + totalRet, 1 / years) - 1;

    const mean  = rets.length ? rets.reduce((a,b)=>a+b,0) / rets.length : 0;
    const sd    = rets.length>1 ? Math.sqrt(rets.reduce((s,x)=>s+(x-mean)**2,0) / rets.length) : 0;
    const annRet= mean * 252;
    const vol   = sd * Math.sqrt(252);

    const neg    = rets.filter(x => x < 0);
    const mNeg   = neg.length ? neg.reduce((a,b)=>a+b,0) / neg.length : 0;
    const sdNeg  = neg.length>1 ? Math.sqrt(neg.reduce((s,x)=>s+(x-mNeg)**2,0) / neg.length) : 0;
    const down   = sdNeg * Math.sqrt(252);

    const sharpe = vol>0 ? (annRet - CFG.rf) / vol     : 0;
    const sortino= down>0 ? (annRet - CFG.rf) / down   : 0;

    // Drawdown系列
    let peak = eqs[0], maxDD = 0, curU = 0, maxU = 0, recDays = 0, inDraw = false, troughIdx = 0, peakIdx = 0, recFound = false;
    const ddSeries = [];
    for (let i=0;i<eqs.length;i++){
      const v = eqs[i];
      if (v > peak) { peak = v; if (inDraw) inDraw = false; }
      const dd = (v - peak) / peak;
      ddSeries.push(dd);
      if (dd < maxDD) { maxDD = dd; inDraw = true; trough = i; peakIdx = eqs.findIndex((x,ix)=> ix<=i && x===peak); }
      if (inDraw) { curU++; if (curU > maxU) maxU = curU; } else { curU = 0; }
    }
    if (peakIdx < troughIdx) {
      const pre = eqs[peakIdx];
      for (let i = troughIdx; i < eqs.length; i++) { if (eqs[i] >= pre) { recDays = i - troughIdx; recFound = true; break; } }
      if (!recFound) recDays = Math.max(0, eqs.length - 1 - troughIdx);
    }
    const onlyNeg = ddSeries.filter(x => x < 0);
    const UI = Math.sqrt( onlyNeg.reduce((s,x)=>s + x*x, 0) / Math.max(1, onlyNeg.length) );

    const wins   = tradePnls.filter(x => x > 0);
    const losses = tradePnls.filter(x => x < 0);
    const PF        = (wins.reduce((a,b)=>a+b,0)) / Math.max(1e-9, Math.abs(losses.reduce((a,b)=>a+b,0)));
    const hit       = tradePnls.length ? (wins.length / tradePnls.length) : 0;
    const expectancy= tradePnls.length ? (tradePnls.reduce((a,b)=>a+b,0) / tradePnls.length) : 0;
    const payoff    = (wins.length? wins.reduce((a,b)=>a+b,0)/wins.length : 0) / Math.max(1e-9, Math.abs(losses.length? losses.reduce((a,b)=>a+b,0)/losses.length : 0));

    const sorted = [...rets].sort((a,b)=>a-b);
    const idx    = Math.max(0, Math.floor(0.05 * (sorted.length - 1)));
    const VaR95  = sorted[idx] || 0;
    const tail   = sorted.slice(0, idx + 1);
    const CVaR95 = tail.length ? tail.reduce((a,b)=>a+b,0) / tail.length : 0;

    const posSum = rets.filter(x=>x>0).reduce((a,b)=>a+b,0);
    const negSum = Math.abs(rets.filter(x=>x<0).reduce((a,b)=>a+b,0));
    const GainPain = negSum > 0 ? (posSum / negSum) : 9.99;
    const posCnt = rets.filter(x=>x>0).length;
    const negCnt = rets.filter(x=>x<0).length;
    const Omega  = negCnt ? (posCnt/negCnt) : 9.99;

    const calmar = (maxDD < 0) ? (CAGR / Math.abs(maxDD)) : 0;
    const rtVol  = vol > 0 ? (annRet / vol) : 0;

    const totalFees   = tradeFees.reduce((a,b)=>a+b,0);
    const totalTaxes  = tradeTaxes.reduce((a,b)=>a+b,0);
    const totalCost   = totalFees + totalTaxes;
    const turnover    = (grossBuy + grossSell) / OPT.capital;
    const avgTradeVal = (grossBuy + grossSell) / Math.max(1, (wins.length + losses.length));
    const costRatio   = (grossBuy + grossSell) > 0 ? (totalCost / (grossBuy + grossSell)) : 0;

    return {
      period : { start: days[0], end: days.at(-1), years },
      equity : { days, series: eqs, ddSeries },
      returns: { daily: rets, annRet, vol, downside: down, VaR95, CVaR95, GainPain, Omega },
      pnl    : { trades: tradePnls, wins, losses, total: tradePnls.reduce((a,b)=>a+b,0), maxWin: Math.max(...tradePnls,0), maxLoss: Math.min(...tradePnls,0) },
      risk   : { maxDD, TU_days: maxU, Rec_days: recDays, MCL: 0, UI, Martin: (UI>0? annRet/UI : 0) },
      ratios : { CAGR, sharpe, sortino, calmar, rtVol, PF, hit, expectancy, payoff, totalRet },
      cost   : { totalFees, totalTaxes, totalCost, grossBuy, grossSell, turnover, avgTradeVal, costRatio }
    };
  }

  // ---------- KPI 渲染 ----------
  function fillRows(tbodySel, rows){
    const tb = $(tbodySel); tb.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3] ? rateHtml(r[3]) : '—'}</td><td class="subtle">${r[4] || '—'}</td>`;
      tb.appendChild(tr);
    }
  }
  function gatherRatings(rows){
    const all = [];
    for (const r of rows) if (r[3]) all.push({ name: r[0], value: r[1], desc: r[2], rating: r[3], band: r[4] });
    return all;
  }
  function pickSuggestions(groups){
    const bag = [];
    groups.forEach(g => bag.push(...gatherRatings(g)));
    const bad = bag.filter(x => x.rating !== 'Strong');
    bad.sort((a,b) => (a.rating==='Improve'?0:(a.rating==='Adequate'?1:2)) - (b.rating==='Improve'?0:(b.rating==='Adequate'?1:2)));
    return bad.map(x => [x.name, x.value, '—', x.rating, x.band]);
  }
  function renderKPI(K){
    $('#kpiOptCard').style.display = '';

    const ret = [
      ['總報酬 (Total Return)', fmtPct(K.ratios.totalRet), '期末/期初 - 1', (K.ratios.totalRet>0?'Strong':'Improve'), '≥0%'],
      ['CAGR 年化',            fmtPct(K.ratios.CAGR),      '長期年化',       (K.ratios.CAGR>=BANDS.CAGR.strong?'Strong':(K.ratios.CAGR>=BANDS.CAGR.adequate?'Adequate':'Improve')), '≥15% / ≥5%'],
      ['Arithmetic 年化',      fmtPct(K.returns.annRet),   '日均×252',       (K.returns.annRet>=0.20?'Strong':(K.returns.annRet>=0.05?'Adequate':'Improve')), '≥20% / ≥5%'],
      ['平均每筆淨損益',        fmtInt(K.ratios.expectancy),'交易損益均值',    (K.ratios.expectancy>0?'Strong':'Improve'), '> 0'],
      ['勝率 (Hit Ratio)',      fmtPct(K.ratios.hit),       '獲利筆數/總筆數', (K.ratios.hit>=BANDS.Hit.strong?'Strong':(K.ratios.hit>=BANDS.Hit.adequate?'Adequate':'Improve')), '≥55% / ≥45%'],
      ['累積淨利 (NTD)',        fmtInt(K.pnl.total),        '所有賣出筆加總',   (K.pnl.total>0?'Strong':'Improve'), '> 0'],
      ['單筆最大獲利/虧損',     `${fmtInt(K.pnl.maxWin)} / ${fmtInt(K.pnl.maxLoss)}`, '極值', 'Adequate','—']
    ];
    fillRows('#kpiOptReturn tbody', ret);

    const risk = [
      ['最大回撤 (MaxDD)',      fmtPct(K.risk.maxDD),         '峰值到谷底',         (K.risk.maxDD<=BANDS.MaxDD.strong?'Strong':(K.risk.maxDD<=BANDS.MaxDD.adequate?'Adequate':'Improve')), '≥-10% / ≥-25%'],
      ['水下時間 (TU)',         K.risk.TU_days+' 天',         '在水下的最長天數',     (K.risk.TU_days<=BANDS.TU_days.strong?'Strong':(K.risk.TU_days<=BANDS.TU_days.adequate?'Adequate':'Improve')), '≤45 / ≤120'],
      ['回本時間 (Recovery)',   K.risk.Rec_days+' 天',        '回到新高所需天數',     (K.risk.Rec_days<=BANDS.Rec_days.strong?'Strong':(K.risk.Rec_days<=BANDS.Rec_days.adequate?'Adequate':'Improve')), '≤45 / ≤90'],
      ['波動率 (Volatility)',   fmtPct(K.returns.vol),        '年化標準差',           (K.returns.vol<=BANDS.Vol.strong?'Strong':(K.returns.vol<=BANDS.Vol.adequate?'Adequate':'Improve')), '≤20% / ≤35%'],
      ['下行波動 (Downside)',   fmtPct(K.returns.downside),   '下行波動(年化)',       (K.returns.downside<=0.15?'Strong':(K.returns.downside<=0.30?'Adequate':'Improve')), '≤15% / ≤30%'],
      ['Ulcer Index (UI)',      fmtPct(K.risk.UI),            '回撤平方均根',         (K.risk.UI<=BANDS.UI.strong?'Strong':(K.risk.UI<=BANDS.UI.adequate?'Adequate':'Improve')), '≤5% / ≤12%'],
      ['Martin Ratio',          (K.risk.Martin).toFixed(2),   '年化報酬/UI',          (K.risk.Martin>=BANDS.Martin.strong?'Strong':(K.risk.Martin>=BANDS.Martin.adequate?'Adequate':'Improve')), '≥0.8 / ≥0.3'],
      ['VaR 95% (1日)',         fmtPct(K.returns.VaR95),      '95%一日風險',         (K.returns.VaR95>=BANDS.VaR95.strong?'Strong':(K.returns.VaR95>=BANDS.VaR95.adequate?'Adequate':'Improve')), '>-2% / >-4%'],
      ['CVaR 95% (1日)',        fmtPct(K.returns.CVaR95),     '超過VaR的平均虧損',     (K.returns.CVaR95>=BANDS.CVaR95.strong?'Strong':(K.returns.CVaR95>=BANDS.CVaR95.adequate?'Adequate':'Improve')), '>-3% / >-6%']
    ];
    fillRows('#kpiOptRisk tbody', risk);

    const eff = [
      ['Sharpe',     (K.ratios.sharpe).toFixed(2), '風險調整報酬', (K.ratios.sharpe>=BANDS.Sharpe.strong?'Strong':(K.ratios.sharpe>=BANDS.Sharpe.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.5'],
      ['Sortino',    (K.ratios.sortino).toFixed(2),'下行風險報酬', (K.ratios.sortino>=BANDS.Sortino.strong?'Strong':(K.ratios.sortino>=BANDS.Sortino.adequate?'Adequate':'Improve')), '≥1.5 / ≥0.75'],
      ['Calmar',     (K.ratios.calmar).toFixed(2), 'CAGR/|MaxDD|', (K.ratios.calmar>=BANDS.Calmar.strong?'Strong':(K.ratios.calmar>=BANDS.Calmar.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.3'],
      ['Reward/Vol', (K.ratios.rtVol).toFixed(2),  '年化報酬/波動', (K.ratios.rtVol>=BANDS.RtVol.strong?'Strong':(K.ratios.rtVol>=BANDS.RtVol.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.5'],
      ['Profit Factor (PF)', (K.ratios.PF).toFixed(2),'總獲利/總虧損', (K.ratios.PF>=BANDS.PF.strong?'Strong':(K.ratios.PF>=BANDS.PF.adequate?'Adequate':'Improve')), '≥1.5 / ≥1.0'],
      ['Payoff Ratio', (K.ratios.payoff).toFixed(2),'均獲利/均虧損',  (K.ratios.payoff>=BANDS.Payoff.strong?'Strong':(K.ratios.payoff>=BANDS.Payoff.adequate?'Adequate':'Improve')), '≥1.5 / ≥1.0']
    ];
    fillRows('#kpiOptEff tbody', eff);

    const stab = [
      ['偏態 (Skewness)', (K.returns.daily.length? (function(){const m=K.returns.daily.reduce((a,b)=>a+b,0)/K.returns.daily.length; const s=Math.sqrt(K.returns.daily.reduce((x,y)=>x+(y-m)*(y-m),0)/Math.max(1,K.returns.daily.length)); if(!s) return 0; return (K.returns.daily.length/((K.returns.daily.length-1)*(K.returns.daily.length-2))) * K.returns.daily.reduce((x,y)=>x+Math.pow((y-m)/s,3),0);})():0).toFixed(2), '分配偏度','Strong','> 0'],
      ['峰度 (Kurtosis)', (K.returns.daily.length? (function(){const m=K.returns.daily.reduce((a,b)=>a+b,0)/K.returns.daily.length; const s=Math.sqrt(K.returns.daily.reduce((x,y)=>x+(y-m)*(y-m),0)/Math.max(1,K.returns.daily.length)); if(!s) return 0; const m4=K.returns.daily.reduce((x,y)=>x+Math.pow(y-m,4),0)/K.returns.daily.length; return m4/Math.pow(s,4);})():0).toFixed(2), '分配峰度(≈3常態)','Adequate','≤10']
    ];
    fillRows('#kpiOptStab tbody', stab);

    const cost = [
      ['總費用(手續費+稅)', fmtInt(K.cost.totalFees + K.cost.totalTaxes), '所有賣出筆累計', 'Adequate', '—'],
      ['費用比 (Cost Ratio)', fmtPct(K.cost.costRatio), '(費用/成交額)', (K.cost.costRatio<=BANDS.CostRatio.strong?'Strong':(K.cost.costRatio<=BANDS.CostRatio.adequate?'Adequate':'Improve')), '<0.10% / <0.30%'],
      ['成交額週轉率 (Turnover)', (K.cost.turnover).toFixed(2)+'x', '成交額/本金', (K.cost.turnover<=BANDS.Turnover.strong?'Strong':(K.cost.turnover<=BANDS.Turnover.adequate?'Adequate':'Improve')), '1~2x'],
      ['筆均成交額 (Avg Trade Value)', fmtInt(K.cost.avgTradeVal), '成交額/筆數', (K.cost.avgTradeVal>=100000?'Strong':(K.cost.avgTradeVal>=30000?'Adequate':'Improve')), '≥100k / ≥30k'],
      ['買入總額 / 賣出總額', `${fmtInt(K.cost.grossBuy)} / ${fmtInt(K.cost.grossSell)}`, '流動性利用', 'Adequate','—'],
      ['Omega(0%)', (K.returns.Omega).toFixed(2), 'P(R>0)/P(R<0)', (K.returns.Omega>=BANDS.Omega.strong?'Strong':(K.returns.Omega>=BANDS.Omega.adequate?'Adequate':'Improve')), '≥1.5 / ≥1.0'],
      ['MAR (CAGR/MaxDD)', (K.ratios.calmar).toFixed(2), '等同 Calmar', (K.ratios.calmar>=BANDS.MAR.strong?'Strong':(K.ratios.calmar>=BANDS.MAR.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.3']
    ];
    fillRows('#kpiOptCost tbody', cost);

    const sugg = pickSuggestions([ret, risk, eff, stab, cost]);
    fillRows('#kpiOptSuggest tbody', sugg);

    const benchBody = $('#kpiOptBench tbody');
    benchBody.innerHTML = `<tr><td colspan="4">— 尚未連結基準（可用 ?benchmark=0050 / ?benchmark=TWII / ?benchfile= 或 ?benchurl= 指定）</td></tr>`;
  }

  // ---------- 最佳化表 ----------
  function renderOptTable(rows){
    const thead=$('#optTable thead'), tbody=$('#optTable tbody');
    thead.innerHTML=`<tr>
      <th>種類</th><th>日期</th><th>成交價格</th><th>成本均價</th><th>成交數量</th>
      <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
      <th>成本</th><th>累計成本</th><th>損益</th><th>報酬率</th><th>累計損益</th>
    </tr>`;
    tbody.innerHTML='';
    for(const e of rows){
      const tr=document.createElement('tr'); tr.className=(e.side==='BUY'?'buy-row':'sell-row');
      tr.innerHTML=`<td>${e.side==='BUY'?'買進':'賣出'}</td>
        <td>${tsPretty(e.ts)}</td><td>${Number(e.price).toFixed(2)}</td>
        <td>${e.avgCost!=null?Number(e.avgCost).toFixed(2):'—'}</td><td>${fmtInt(e.shares||0)}</td>
        <td>${fmtInt(e.buyAmount||0)}</td><td>${fmtInt(e.sellAmount||0)}</td>
        <td>${fmtInt(e.fee||0)}</td><td>${fmtInt(e.tax||0)}</td>
        <td>${fmtInt(e.cost||0)}</td><td>${fmtInt(e.cumCost||0)}</td>
        <td>${e.pnlFull==null?'—':(e.pnlFull>0?`<span class="pnl-pos">${fmtInt(e.pnlFull)}</span>`:`<span class="pnl-neg">${fmtInt(e.pnlFull)}</span>`)}</td>
        <td>${e.retPctUnit==null?'—':fmtPct(e.retPctUnit)}</td>
        <td>${e.cumPnlFull==null?'—':(e.cumPnlFull>0?`<span class="pnl-pos">${fmtInt(e.cumPnlFull)}</span>`:`<span class="pnl-neg">${fmtInt(e.cumPnlFull)}</span>`)}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ---------- 主流程 ----------
  async function boot(){
    try{
      set('從 Supabase 讀取清單…');
      const u = new URL(location.href);
      const paramFile = u.searchParams.get('file');

      let latest=null, list=[];
      if(paramFile){
        latest={ name:paramFile.split('/').pop()||'00909.txt', fullPath:paramFile, from:'url' };
      }else{
        list=(await listCandidates()).filter(f=>CFG.want.test(f.name)||CFG.want.test(f.fullPath));
        list.sort((a,b)=>{ const sa=lastDateScore(a.name), sb=lastDateScore(b.name);
          if(sa!==sb) return sb-sa; if(a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt; return (b.size||0)-(a.size||0); });
        latest=list[0];
      }
      if(!latest){ set('找不到檔名含「00909」的 TXT（可用 ?file= 指定）。', true); return; }
      $('#latestName').textContent=latest.name;

      set('下載最新檔…');
      const latestUrl= latest.from==='url'? latest.fullPath : pubUrl(latest.fullPath);
      const txt      = await fetchText(latestUrl);

      set('解析與回測…');
      const rows = window.ETF_ENGINE.parseCanon(txt);
      if(!rows.length){ set('TXT 內無可解析的交易行。', true); return; }

      const start8 = rows[0].day, end8 = rows.at(-1).day;
      $('#periodText').textContent = `期間：${start8} 開始到 ${end8} 結束`;

      const bt = backtest(rows);

      // 標題下的最後一筆買進（若目前仍有持倉）
      renderLastOpenBuy(bt.execs);

      // 週次圖
      renderWeeklyChart(bt.execs);

      // 最佳化 & KPI
      const optExecs = buildOptimizedExecs(bt.execs);
      renderOptTable(optExecs);
      const K = computeKPIFromOpt(optExecs);
      if (K) renderKPI(K);

      // 基準按鈕（保留但不寫 manifest）
      const btn = $('#btnSetBaseline');
      if (btn) { btn.disabled = true; }

      set('完成。');
    }catch(err){
      console.error('[00909 ERROR]', err);
      set('初始化失敗：' + (err?.message || String(err)), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
