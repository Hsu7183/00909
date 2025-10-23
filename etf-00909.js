// etf-00909.js — 00909 策略頁主程式
// 版本：v13-broker-ceil-diff-color-full（上半）
// 口徑：費用/稅「整數進位+最低手續費」；賣出列「累計成本」= 買端累計成本 + 賣方手續費 + 交易稅；
//       「價格差」= 賣出價格 − 賣出列成本均價(含賣費稅)；報酬率 = 損益 / 賣出列累計成本(含賣費稅)；
// 顏色規則：種類—買進紅/賣出綠；金額—買進金額紅/賣出金額綠；價格差/損益/報酬率/累計損益—賺紅/賠綠/0黑。
// 依賴：window.ETF_ENGINE.parseCanon(txt), window.ETF_ENGINE.backtest(rows, CFG)

(function(){
  // ========= 小工具 =========
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m,bad=false)=>{ if(status){ status.textContent=m; status.style.color=bad?'#c62828':'#666'; } };

  const fmtInt = n => Math.round(n || 0).toLocaleString();
  const fmtPct = v => (v==null||!isFinite(v)) ? '—' : (v*100).toFixed(2)+'%';
  const tsPretty = ts14 => `${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;
  const DAY_MS = 24*60*60*1000;

  // 著色：賺=紅、賠=綠、0=黑
  const span = (html,color)=>`<span style="color:${color};font-weight:600">${html}</span>`;
  const cRed  = '#d0021b';
  const cGreen= '#0f8a00';
  const cBlack= '#222';

  const colorBySignHTML = (val, asPercent=false)=>{
    if (val==null || !isFinite(val)) return '—';
    const s = Math.sign(val);
    const txt = asPercent ? fmtPct(val) : fmtInt(val);
    if (s>0)  return span(txt, cRed);
    if (s<0)  return span(txt, cGreen);
    return span(txt, cBlack);
  };

  // ========= 參數 =========
  const url = new URL(location.href);
  const CFG = {
    symbol: '00909',
    bucket: 'reports',
    want: /00909/i,
    // 可用 URL 覆寫：?fee=0.0012&tax=0.001&minfee=20&unit=1000
    feeRate: +(url.searchParams.get('fee') || 0.001425),
    taxRate: +(url.searchParams.get('tax') || 0.001),
    minFee:  +(url.searchParams.get('minfee') || 20),
    unitShares: +(url.searchParams.get('unit') || 1000),
    rf: 0.00,
    initialCapital: 1_000_000,
    manifestPath: 'manifests/etf-00909.json'
  };
  const OPT = { capital: 1_000_000, unitShares: CFG.unitShares, ratio: [1,1,2] };

  // chips
  $('#feeRateChip')?.textContent = (CFG.feeRate*100).toFixed(4)+'%';
  $('#taxRateChip')?.textContent = (CFG.taxRate*100).toFixed(3)+'%';
  $('#minFeeChip')?.textContent  = String(CFG.minFee);
  $('#unitChip')?.textContent    = String(CFG.unitShares);
  $('#slipChip')?.textContent    = '0';
  $('#rfChip')?.textContent      = (CFG.rf*100).toFixed(2)+'%';

  // ========= Supabase =========
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const sb = window.supabase.createClient(
    SUPABASE_URL, SUPABASE_ANON_KEY,
    { global:{ fetch:(u,o={})=>fetch(u,{...o, cache:'no-store'}) } }
  );
  const pubUrl = p => { const {data} = sb.storage.from(CFG.bucket).getPublicUrl(p); return data?.publicUrl || '#'; };

  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(CFG.bucket).list(p, { limit: 1000, sortBy:{ column:'name', order:'asc' } });
    if (error) throw new Error(error.message);
    return (data||[]).map(it => ({ name: it.name, fullPath: p + it.name, updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0, size: it.metadata?.size || 0 }));
  }
  async function listCandidates(){
    const prefix = url.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }
  const lastDateScore = name => {
    const m = String(name).match(/\b(20\d{6})\b/g);
    return m && m.length ? Math.max(...m.map(s => +s || 0)) : 0;
  };

  async function fetchText(u){
    const res = await fetch(u, { cache:'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const trials = ['big5','utf-8','utf-16le','utf-16be','windows-1252'];
    for (const enc of trials){ try{ return new TextDecoder(enc).decode(buf).replace(/\ufeff/gi,''); }catch{} }
    return new TextDecoder('utf-8').decode(buf);
  }

  // ========= 回測（引擎） =========
  const backtest = (rows)=> window.ETF_ENGINE.backtest(rows, CFG);

  // ========= 週次圖 =========
  let chWeekly = null;
  function weekStartDate(ms){
    const d=new Date(ms); const dow=(d.getUTCDay()+6)%7;
    const s=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-dow));
    return s.toISOString().slice(0,10);
  }
  function buildWeeklyFromOpt(optExecs){
    const m=new Map(), order=[];
    for(const e of optExecs){
      if (e.side!=='SELL' || typeof e.pnlFull!=='number') continue;
      const wk = weekStartDate(e.tsMs);
      if(!m.has(wk)){ m.set(wk,0); order.push(wk); }
      m.set(wk, m.get(wk) + e.pnlFull);
    }
    const labels=order, weekly=labels.map(wk=>m.get(wk)||0);
    const cum=[]; let s=0; for(const v of weekly){ s+=v; cum.push(s); }
    return { labels, weekly, cum };
  }
  function renderWeeklyChartFromOpt(optExecs){
    const box=$('#weeklyCard'), ctx=$('#chWeekly'); if(!ctx) return;
    const W = buildWeeklyFromOpt(optExecs);
    if (!W.labels.length){ box.style.display='none'; return; }
    box.style.display='';
    const maxCum=Math.max(...W.cum,0);
    const floatBars=[]; let prev=0; for(const c of W.cum){ floatBars.push([prev,c]); prev=c; }
    if (chWeekly) chWeekly.destroy();
    chWeekly = new Chart(ctx,{
      data:{ labels:W.labels, datasets:[
        { type:'bar',  label:'每週獲利（浮動長條）', data:floatBars, borderWidth:1, backgroundColor:'rgba(13,110,253,0.30)', borderColor:'#0d6efd' },
        { type:'line', label:'累積淨利',             data:W.cum,      borderWidth:2, borderColor:'#f43f5e', tension:0.2, pointRadius:0 }
      ]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}}, parsing:{yAxisKey:undefined},
        scales:{ y:{ suggestedMin:0, suggestedMax:Math.max(1, maxCum*1.05) }, x:{ ticks:{ maxTicksLimit:12 } } } }
    });
  }

  // ========= 券商口徑：費用/稅整數進位 =========
  function feesInt(price, shares, isSell){
    const gross = price * shares;
    const fee = Math.max(CFG.minFee, Math.ceil(gross * CFG.feeRate));
    const tax = isSell ? Math.ceil(gross * CFG.taxRate) : 0;
    return { gross, fee, tax };
  }

  // ========= 目前持有（卡片，多筆換行） =========
  function renderLastOpenBuyFromOpt(optExecs){
    const netShares = optExecs.reduce((acc,e)=> acc + (e.side==='BUY'? e.shares : -e.shares), 0);
    const bar = $('#lastBuyBar'); if(!bar) return;
    if (netShares<=0){ bar.style.display='none'; bar.innerHTML=''; return; }
    let i=optExecs.length-1; while(i>=0 && optExecs[i].side!=='SELL') i--;
    const openBuys = optExecs.slice(i+1).filter(e=>e.side==='BUY');
    if (!openBuys.length){ bar.style.display='none'; bar.innerHTML=''; return; }
    const rows = openBuys.map(b =>
      `買進　<b>${tsPretty(b.ts)}</b>　成交價格 <b>${Number(b.price).toFixed(2)}</b>　成交數量 <b>${fmtInt(b.shares)}</b>　持有數量 <b>${fmtInt(netShares)}</b>`
    );
    bar.innerHTML = `目前持有：<br>${rows.join('<br>')}`;
    bar.style.display='';
  }

  // ========= 最佳化交易（本金100萬；1/1/2；資金不足縮量；未平倉保留BUY） =========
  function splitSegments(execs){
    const segs=[], cur=[];
    for(const e of execs){ cur.push(e); if(e.side==='SELL'){ segs.push(cur.splice(0)); } }
    if (cur.length) segs.push(cur);
    return segs;
  }
  function buyCostLots(price, lots){
    const shares = lots * CFG.unitShares;
    const f = feesInt(price, shares, false);
    return { cost:f.gross + f.fee, shares, f };
  }
  function buildOptimizedExecs(execs){
    const segs = splitSegments(execs), out=[]; let cumPnlAll=0;

    for(const seg of segs){
      const buys = seg.filter(x=>x.side==='BUY');
      const sell = seg.find(x=>x.side==='SELL');
      if(!buys.length) continue;

      const p0  = buys[0].price;
      const one = buyCostLots(p0,1).cost;
      let maxLotsTotal = Math.floor(OPT.capital / one);
      if (maxLotsTotal <= 0) continue;

      // 1-1-2 規劃
      let q = Math.floor(maxLotsTotal/4); if (q<=0) q=1;
      const n    = Math.min(3, buys.length);
      const plan = [q,q,2*q].slice(0, n);

      let remaining = OPT.capital, sharesHeld = 0, cumCost = 0;
      const unitCount = plan.reduce((a,b)=>a+b,0);

      // BUYs（整數進位費用）
      for (let i=0;i<n;i++) {
        const b = buys[i];
        let lots = plan[i];

        const oneC = buyCostLots(b.price, 1).cost;
        let affordable = Math.floor(remaining / oneC);
        if (affordable <= 0) break;
        if (lots > affordable) lots = affordable;

        const bc = buyCostLots(b.price, lots);
        remaining -= bc.cost;
        cumCost   += bc.cost;
        sharesHeld += bc.shares;

        // 顯示用成本均價（買）：(買進金額+買方手續費)/當筆股數
        const costAvgDisp = (bc.f.gross + bc.f.fee) / bc.shares;

        out.push({
          side:'BUY', ts:b.ts, tsMs:b.tsMs, price:b.price, shares:bc.shares,
          buyAmount:bc.f.gross, sellAmount:0, fee:bc.f.fee, tax:0,
          cost:bc.cost, cumCost,
          costAvgDisp,
          pnlFull:null, retPctUnit:null, cumPnlFull:cumPnlAll
        });
      }

      // SELL（一次賣出段內全部 sharesHeld）
      if (sell && sharesHeld > 0) {
        const st = feesInt(sell.price, sharesHeld, true);

        // 實現損益：淨賣出 − 段內買端累計成本
        const pnlFull = st.gross - (st.fee + st.tax) - cumCost;
        cumPnlAll += pnlFull;

        // 顯示用：賣出列累計成本(含賣費稅)、賣出列成本均價(含賣費稅)、價格差=賣出價格-賣出列成本均價
        const sellCumCostDisp = cumCost + st.fee + st.tax;
        const sellCostAvgDisp = sellCumCostDisp / sharesHeld;
        const priceDiff       = sell.price - sellCostAvgDisp;   // ★ 符合你指定：21.19-20.74=0.45

        out.push({
          side:'SELL', ts:sell.ts, tsMs:sell.tsMs, price:sell.price, shares:sharesHeld,
          buyAmount:0, sellAmount:st.gross, fee:st.fee, tax:st.tax,
          cost:0, cumCost,                         // 計算用（買端累計）
          cumCostDisp:sellCumCostDisp,             // 顯示用（含賣方費稅）
          costAvgDisp:sellCostAvgDisp,             // 顯示用（含賣方費稅）
          priceDiff,                                // 顯示用（賣出價格 - 成本均價）
          pnlFull,
          retPctUnit: sellCumCostDisp>0 ? (pnlFull / sellCumCostDisp) : null, // 報酬率
          cumPnlFull:cumPnlAll
        });
      }
    }

    out.sort((a,b)=> a.tsMs - b.tsMs);
    return out;
  }
  // ========= KPI 計算（完整） =========
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
    Martin:{strong:0.8, adequate:0.3}
  };
  const rateHtml = l => `<span class="${l==='Strong'?'rate-strong':(l==='Adequate'?'rate-adequate':'rate-improve')}">${l==='Strong'?'Strong (強)':(l==='Adequate'?'Adequate (可)':'Improve (弱)')}</span>`;
  const rateHigher=(v,b)=> v>=b.strong ? 'Strong' : (v>=b.adequate ? 'Adequate' : 'Improve');

  function computeKPIFromOpt(optExecs){
    if(!optExecs.length) return null;

    let equity = OPT.capital;
    const timeline=[], tradePnls=[], tradeFees=[], tradeTaxes=[];
    let grossBuy=0, grossSell=0, cumPnl=0;

    for (const e of optExecs){
      if (e.side==='BUY'){ equity -= (e.cost||0); grossBuy += (e.buyAmount||0); }
      else {
        equity += (e.sellAmount||0) - (e.fee||0) - (e.tax||0);
        if (typeof e.pnlFull==='number'){ tradePnls.push(e.pnlFull); cumPnl += e.pnlFull; }
        tradeFees.push(e.fee||0); tradeTaxes.push(e.tax||0); grossSell += (e.sellAmount||0);
      }
      timeline.push({t:e.tsMs, eq:equity});
    }

    // 日末權益與報酬
    const byDay=new Map(); for(const p of timeline){ const d=new Date(p.t).toISOString().slice(0,10); byDay.set(d,p.eq); }
    const days=[...byDay.keys()].sort(); const eqs=days.map(d=>byDay.get(d));
    const rets=[]; for (let i=1;i<eqs.length;i++){ const a=eqs[i-1], b=eqs[i]; if(a>0) rets.push(b/a-1); }

    // 以 ΣpnlFull 計總報酬/年化（避免分段資金低估）
    const t0=new Date(days[0]).getTime(), t1=new Date(days.at(-1)).getTime();
    const years=Math.max(1/365,(t1-t0)/(365*DAY_MS));
    const totalRet = cumPnl / OPT.capital;
    const CAGR     = Math.pow(1+totalRet,1/years)-1;

    // 風險
    const mean=rets.length? rets.reduce((a,b)=>a+b,0)/rets.length : 0;
    const sd  =rets.length>1? Math.sqrt(rets.reduce((s,x)=>s+(x-mean)*(x-mean),0)/rets.length) : 0;
    const annRet=mean*252, vol=sd*Math.sqrt(252);

    // Drawdown 與衍生（TU/Recovery/UI/Martin）
    let peak=eqs[0], maxDD=0, curU=0, maxU=0, recDays=0, inDraw=false, troughIdx=0, peakIdx=0, recFound=false;
    const ddSeries=[];
    for(let i=0;i<eqs.length;i++){
      const v=eqs[i];
      if(v>peak){ peak=v; if(inDraw) inDraw=false; }
      const dd=(v-peak)/peak; ddSeries.push(dd);
      if(dd<maxDD){ maxDD=dd; inDraw=true; troughIdx=i; peakIdx=eqs.findIndex((x,ix)=> ix<=i && x===peak); }
      if(inDraw){ curU++; maxU=Math.max(maxU,curU); } else curU=0;
    }
    if(peakIdx<troughIdx){
      const pre=eqs[peakIdx]; for(let i=troughIdx;i<eqs.length;i++){ if(eqs[i]>=pre){ recDays=i-troughIdx; recFound=true; break; } }
      if(!recFound) recDays = Math.max(0, eqs.length-1-troughIdx);
    }
    const ddNeg=ddSeries.filter(x=>x<0);
    const UI = Math.sqrt(ddNeg.reduce((s,x)=>s+x*x,0)/Math.max(1,ddNeg.length));
    const Martin = UI>0? (annRet/UI) : 0;

    // 效率
    const wins=tradePnls.filter(x=>x>0), losses=tradePnls.filter(x=>x<0);
    const PF=(wins.reduce((a,b)=>a+b,0))/(Math.abs(losses.reduce((a,b)=>a+b,0))||1);
    const hit=tradePnls.length? wins.length/tradePnls.length : 0;
    const expectancy=tradePnls.length? tradePnls.reduce((a,b)=>a+b,0)/tradePnls.length : 0;
    const payoff=(wins.length? wins.reduce((a,b)=>a+b,0)/wins.length : 0) / (Math.abs(losses.length? losses.reduce((a,b)=>a+b,0)/losses.length : 1));
    const rtVol = vol>0? annRet/vol : 0;
    const calmar = maxDD<0? CAGR/Math.abs(maxDD) : 0;

    // 成本/流動
    const totalFees=tradeFees.reduce((a,b)=>a+b,0);
    const totalTaxes=tradeTaxes.reduce((a,b)=>a+b,0);
    const turnover=(grossBuy+grossSell)/OPT.capital;
    const avgTradeValue=(grossBuy+grossSell)/Math.max(1,(wins.length+losses.length));
    const costRatio=(grossBuy+grossSell)>0? (totalFees+totalTaxes)/(grossBuy+grossSell) : 0;

    return {
      period : { start: days[0], end: days.at(-1), years },
      equity : { days, series:eqs, ddSeries },
      returns: { daily: rets, annRet, vol },
      pnl    : { trades: tradePnls, wins, losses, total: tradePnls.reduce((a,b)=>a+b,0), maxWin: Math.max(...tradePnls,0), maxLoss: Math.min(...tradePnls,0) },
      risk   : { maxDD, TU_days: maxU, Rec_days: recDays, MCL: 0, UI, Martin },
      ratios : { CAGR, sharpe:(vol>0)?(annRet-CFG.rf)/vol:0, sortino:0, calmar, rtVol, PF, hit, expectancy, payoff, totalRet },
      cost   : { totalFees, totalTaxes, costRatio, grossBuy, grossSell, turnover, avgTradeValue }
    };
  }

  // ========= KPI 渲染 =========
  function fillRows(sel, rows){
    const tb=$(sel); if(!tb) return; tb.innerHTML='';
    for(const r of rows){
      const tr=document.createElement('tr');
      tr.innerHTML = `<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]??'—'}</td>`;
      tb.appendChild(tr);
    }
  }
  function fillRowsWithRating(sel, rows){
    const tb=$(sel); if(!tb) return; tb.innerHTML='';
    for(const r of rows){
      const tr=document.createElement('tr');
      tr.innerHTML = `<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]?rateHtml(r[3]):'—'}</td><td class="subtle">${r[4]||'—'}</td>`;
      tb.appendChild(tr);
    }
  }
  function gatherRatings(rows){ const all=[]; for(const r of rows) if(r[3]) all.push({ name:r[0], value:r[1], desc:r[2], rating:r[3], band:r[4] }); return all; }
  function pickSuggestions(groups){
    const bag=[]; groups.forEach(g => bag.push(...gatherRatings(g)));
    const bad = bag.filter(x => x.rating !== 'Strong');
    bad.sort((a,b) => (a.rating==='Improve'?0:(a.rating==='Adequate'?1:2)) - (b.rating==='Improve'?0:(b.rating==='Adequate'?1:2)));
    return bad.map(x => [x.name, x.value, '—', x.rating, x.band]);
  }

  function renderKPI(K){
    $('#kpiOptCard').style.display = '';

    const ret = [
      ['總報酬 (Total Return)', fmtPct(K.ratios.totalRet), 'Σ(Sell淨利)/本金', (K.ratios.totalRet>0?'Strong':'Improve'), '≥0%'],
      ['CAGR 年化',            fmtPct(K.ratios.CAGR),      '((1+總報酬)^(1/年)-1)', (K.ratios.CAGR>=BANDS.CAGR.strong?'Strong':(K.ratios.CAGR>=BANDS.CAGR.adequate?'Adequate':'Improve')), '≥15% / ≥5%'],
      ['Arithmetic 年化',      fmtPct(K.returns.annRet),   '日均×252', (K.returns.annRet>=0.20?'Strong':(K.returns.annRet>=0.05?'Adequate':'Improve')), '≥20% / ≥5%'],
      ['平均每筆淨損益',        fmtInt(K.ratios.expectancy),'交易損益均值', (K.ratios.expectancy>0?'Strong':'Improve'), '> 0'],
      ['勝率 (Hit Ratio)',      fmtPct(K.ratios.hit),       '獲利筆數/總筆數', (K.ratios.hit>=BANDS.Hit.strong?'Strong':(K.ratios.hit>=BANDS.Hit.adequate?'Adequate':'Improve')), '≥55% / ≥45%'],
      ['累積淨利 (NTD)',        fmtInt(K.pnl.total),        '所有賣出筆加總', (K.pnl.total>0?'Strong':'Improve'), '> 0'],
      ['單筆最大獲利/虧損',     `${fmtInt(K.pnl.maxWin)} / ${fmtInt(K.pnl.maxLoss)}`, '極值', 'Adequate', '—']
    ];
    fillRowsWithRating('#kpiOptReturn tbody', ret);

    const risk = [
      ['最大回撤 (MaxDD)',      fmtPct(K.risk.maxDD),       '峰值到谷底', (K.risk.maxDD<=BANDS.MaxDD.strong?'Strong':(K.risk.maxDD<=BANDS.MaxDD.adequate?'Adequate':'Improve')), '≥-10% / ≥-25%'],
      ['水下時間 (TU)',         K.risk.TU_days+' 天',       '在水下最長天數', (K.risk.TU_days<=BANDS.TU_days.strong?'Strong':(K.risk.TU_days<=BANDS.TU_days.adequate?'Adequate':'Improve')), '≤45 / ≤120'],
      ['回本時間 (Recovery)',   K.risk.Rec_days+' 天',      '回到新高所需', (K.risk.Rec_days<=BANDS.Rec_days.strong?'Strong':(K.risk.Rec_days<=BANDS.Rec_days.adequate?'Adequate':'Improve')), '≤45 / ≤90'],
      ['波動率 (Volatility)',   fmtPct(K.returns.vol),      '年化標準差', (K.returns.vol<=BANDS.Vol.strong?'Strong':(K.returns.vol<=BANDS.Vol.adequate?'Adequate':'Improve')), '≤20% / ≤35%'],
      ['下行波動 (Downside)',   fmtPct(K.returns.downside), '下行年化', (K.returns.downside<=0.15?'Strong':(K.returns.downside<=0.30?'Adequate':'Improve')), '≤15% / ≤30%'],
      ['Ulcer Index (UI)',      fmtPct(K.risk.UI),          '回撤平方均根', (K.risk.UI<=BANDS.UI.strong?'Strong':(K.risk.UI<=BANDS.UI.adequate?'Adequate':'Improve')), '≤5% / ≤12%'],
      ['Martin Ratio',          (K.risk.Martin).toFixed(2), '年化/UI', (K.risk.Martin>=BANDS.Martin.strong?'Strong':(K.risk.Martin>=BANDS.Martin.adequate?'Adequate':'Improve')), '≥0.8 / ≥0.3']
    ];
    fillRowsWithRating('#kpiOptRisk tbody', risk);

    const eff = [
      ['Sharpe',     (K.ratios.sharpe).toFixed(2), '風險調整報酬', (K.ratios.sharpe>=BANDS.Sharpe.strong?'Strong':(K.ratios.sharpe>=BANDS.Sharpe.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.5'],
      ['Sortino',    (K.ratios.sortino).toFixed(2),'下行風險報酬', (K.ratios.sortino>=BANDS.Sortino.strong?'Strong':(K.ratios.sortino>=BANDS.Sortino.adequate?'Adequate':'Improve')), '≥1.5 / ≥0.75'],
      ['Calmar',     (K.ratios.calmar).toFixed(2), 'CAGR/|MaxDD|', (K.ratios.calmar>=BANDS.Calmar.strong?'Strong':(K.ratios.calmar>=BANDS.Calmar.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.3'],
      ['Reward/Vol', (K.ratios.rtVol).toFixed(2),  '年化/波動', (K.ratios.rtVol>=BANDS.RtVol.strong?'Strong':(K.ratios.rtVol>=BANDS.RtVol.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.5'],
      ['Profit Factor (PF)', (K.ratios.PF).toFixed(2),'總獲利/總虧損', (K.ratios.PF>=BANDS.PF.strong?'Strong':(K.ratios.PF>=BANDS.PF.adequate?'Adequate':'Improve')), '≥1.5 / ≥1.0'],
      ['Payoff Ratio', (K.ratios.payoff).toFixed(2),'均獲利/均虧損',  (K.ratios.payoff>=BANDS.Payoff.strong?'Strong':(K.ratios.payoff>=BANDS.Payoff.adequate?'Adequate':'Improve')), '≥1.5 / ≥1.0']
    ];
    fillRowsWithRating('#kpiOptEff tbody', eff);

    const stab = [
      ['偏態 (Skewness)', '—', '分配偏度(>0偏右尾)', 'Adequate', '資料需求：更長期'],
      ['峰度 (Kurtosis)', '—', '分配峰度(≈3常態；>10尾風險高)', 'Adequate', '資料需求：更長期']
    ];
    fillRowsWithRating('#kpiOptStab tbody', stab);

    const cost = [
      ['費用比 (Cost Ratio)', fmtPct(K.cost.costRatio), '費用/成交額', (K.cost.costRatio<=BANDS.CostRatio.strong?'Strong':(K.cost.costRatio<=BANDS.CostRatio.adequate?'Adequate':'Improve')), '<0.10% / <0.30%'],
      ['成交額週轉率 (Turnover)', (K.cost.turnover).toFixed(2)+'x', '成交額/本金', (K.cost.turnover<=BANDS.Turnover.strong?'Strong':(K.cost.turnover<=BANDS.Turnover.adequate?'Adequate':'Improve')), '1~2x'],
      ['筆均成交額 (Avg Trade Value)', fmtInt(K.cost.avgTradeValue), '成交額/筆數', (K.cost.avgTradeValue>=100000?'Strong':(K.cost.avgTradeValue>=30000?'Adequate':'Improve')), '≥100k / ≥30k'],
      ['買入總額 / 賣出總額', `${fmtInt(K.cost.grossBuy)} / ${fmtInt(K.cost.grossSell)}`, '流動性利用', 'Adequate','—'],
      ['Omega(0%)', (K.returns.Omega).toFixed(2), 'P(R>0)/P(R<0)', (K.returns.Omega>=BANDS.Omega.strong?'Strong':(K.returns.Omega>=BANDS.Omega.adequate?'Adequate':'Improve')), '≥1.5 / ≥1.0'],
      ['MAR (CAGR/MaxDD)', (K.ratios.calmar).toFixed(2), '等同 Calmar', (K.ratios.calmar>=BANDS.MAR.strong?'Strong':(K.ratios.calmar>=BANDS.MAR.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.3']
    ];
    fillRowsWithRating('#kpiOptCost tbody', cost);

    const sugg = pickSuggestions([ret, risk, eff, stab, cost]);
    const tbSug = $('#kpiOptSuggest tbody'); if (tbSug){ tbSug.innerHTML=''; for (const r of sugg){ const tr=document.createElement('tr'); tr.innerHTML = `<td>${r[0]}</td><td>${r[1]}</td><td>—</td><td>${rateHtml(r[3])}</td><td class="subtle">${r[4]}</td>`; tbSug.appendChild(tr);} }

    // 基準占位（如需基準請用 ?benchmark / ?benchfile / ?benchurl）
    const benchBody = $('#kpiOptBench tbody'); if (benchBody) benchBody.innerHTML = '<tr><td colspan="4">— 尚未連結基準（可用 <code>?benchmark=0050</code> / <code>?benchfile=</code> 或 <code>?benchurl=</code> 指定）</td></tr>';
  }

  // ========= 明細表渲染（含顏色與價格差） =========
  function renderOptTable(optExecs){
    const thead=$('#optTable thead'), tbody=$('#optTable tbody');
    if (!thead || !tbody) return;
    thead.innerHTML=`<tr>
      <th>日期</th><th>種類</th><th>成交價格</th><th>成交數量</th>
      <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
      <th>成本</th><th>成本均價</th><th>累計成本</th><th>價格差</th><th>損益</th><th>報酬率</th><th>累計損益</th>
    </tr>`;
    tbody.innerHTML='';
    for(const e of optExecs){
      const isSell = e.side==='SELL';
      const costAvgDisp = e.costAvgDisp!=null ? Number(e.costAvgDisp).toFixed(2) : '—';
      const cumCostDisp = isSell ? (e.cumCostDisp ?? (e.cumCost + (e.fee||0) + (e.tax||0))) : (e.cumCost||0);
      const priceDiff   = isSell ? (e.priceDiff!=null ? e.priceDiff : null) : null;

      // 類別與金額顏色
      const typeHTML    = isSell ? span('賣出', cGreen) : span('買進', cRed);
      const buyAmtHTML  = e.buyAmount  ? span(fmtInt(e.buyAmount),  cRed)  : '0';
      const sellAmtHTML = e.sellAmount ? span(fmtInt(e.sellAmount), cGreen): '0';

      const priceDiffCell = (priceDiff==null)? '—' : colorBySignHTML(priceDiff,false);
      const pnlCell       = e.pnlFull==null ? '—' : colorBySignHTML(e.pnlFull,false);
      const retPctShow    = (isSell && e.retPctUnit!=null)? colorBySignHTML(e.retPctUnit,true) : '—';
      const cumPnlCell    = e.cumPnlFull==null ? span(fmtInt(0), cBlack) : colorBySignHTML(e.cumPnlFull,false);

      const tr=document.createElement('tr'); tr.className=isSell?'sell-row':'buy-row';
      tr.innerHTML=`
        <td>${tsPretty(e.ts)}</td>
        <td>${typeHTML}</td>
        <td>${Number(e.price).toFixed(2)}</td>
        <td>${fmtInt(e.shares||0)}</td>
        <td>${buyAmtHTML}</td>
        <td>${sellAmtHTML}</td>
        <td>${fmtInt(e.fee||0)}</td>
        <td>${fmtInt(e.tax||0)}</td>
        <td>${fmtInt(e.cost||0)}</td>
        <td>${costAvgDisp}</td>
        <td>${fmtInt(cumCostDisp||0)}</td>
        <td>${priceDiffCell}</td>
        <td>${pnlCell}</td>
        <td>${retPctShow}</td>
        <td>${cumPnlCell}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ========= 基準相關（完整） =========
  async function loadBenchmarkTextFromParams(){
    const benchUrl  = url.searchParams.get('benchurl');
    const benchFile = url.searchParams.get('benchfile');
    const benchSym  = url.searchParams.get('benchmark');

    if (benchUrl){
      $('#baseName')?.textContent = benchUrl.split('/').pop()||'bench';
      return { raw:await fetchText(benchUrl), how:'benchurl', src:benchUrl };
    }
    if (benchFile){
      $('#baseName')?.textContent = benchFile.split('/').pop()||'bench.txt';
      const u=pubUrl(benchFile);
      return { raw:await fetchText(u), how:'benchfile', src:u };
    }
    if (benchSym){
      $('#baseName')?.textContent = benchSym;
      try{
        const manPath=`manifests/etf-${benchSym}.json`, manUrl=pubUrl(manPath);
        const r=await fetch(manUrl,{cache:'no-store'}); if(!r.ok) throw new Error('manifest not found');
        const J=await r.json();
        const candidate=J.latest||J.file||J.path||J.url||(Array.isArray(J.files)&&J.files[0])||null;
        if(!candidate) throw new Error('manifest empty');
        const purl=/^https?:\/\//i.test(candidate)?candidate:pubUrl(String(candidate));
        return { raw:await fetchText(purl), how:`benchmark=${benchSym}`, src:purl };
      }catch(e){
        return { raw:null, how:`benchmark=${benchSym}`, src:'(manifest missing)', err:e.message||String(e) };
      }
    }
    return { raw:null, how:'(no param)', src:'—' };
  }
  function seriesFromRows(rows){
    const bt=backtest(rows); let equity=OPT.capital;
    const byDay=new Map(),events=[];
    for(const e of bt.execs){
      if(e.side==='BUY'){ equity-=(e.cost||0); } else { equity+=(e.sellAmount||0)-(e.fee||0)-(e.tax||0); }
      events.push({t:e.tsMs,eq:equity});
    }
    for(const p of events){ const d=new Date(p.t).toISOString().slice(0,10); byDay.set(d,p.eq); }
    const days=[...byDay.keys()].sort(); const eqs=days.map(d=>byDay.get(d));
    const rets=[]; for(let i=1;i<eqs.length;i++){ const a=eqs[i-1], b=eqs[i]; if(a>0) rets.push(b/a-1); }
    return { days, eqs, rets };
  }
  function alignRets(daysA, retsA, daysB, retsB){
    const mapA=new Map(), mapB=new Map();
    for(let i=1;i<daysA.length;i++) mapA.set(daysA[i], retsA[i-1]);   // rets 對應當天
    for(let i=1;i<daysB.length;i++) mapB.set(daysB[i], retsB[i-1]);
    const keys=[...new Set([...mapA.keys(),...mapB.keys()])].sort();
    const a=[], b=[];
    for(const d of keys){ if(mapA.has(d) && mapB.has(d)){ a.push(mapA.get(d)); b.push(mapB.get(d)); } }
    return { a, b };
  }
  function meanStd(x){ if(!x.length) return {m:0,s:0}; const m=x.reduce((p,c)=>p+c,0)/x.length; const v=x.reduce((p,c)=>p+(c-m)*(c-m),0)/x.length; return {m,s:Math.sqrt(v)}; }
  function olsAlphaBeta(y, x){
    const n=Math.min(y.length,x.length); if(n===0) return {alpha:0,beta:0,r2:0};
    const mx=x.reduce((a,b)=>a+b,0)/n, my=y.reduce((a,b)=>a+b,0)/n;
    let num=0, den=0, sxx=0, syy=0, sxy=0;
    for (let i=0;i<n;i++){
      const dx=x[i]-mx, dy=y[i]-my;
      num+=dx*dy; den+=dx*dx;
      sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy;
    }
    const beta=den?num/den:0;
    const alpha=my-beta*mx;
    const r2=(sxx>0&&syy>0)?(sxy*sxy)/(sxx*syy):0;
    return { alpha, beta, r2 };
  }
  function monthHitRate(days, rets){
    const bucket=new Map(); // YYYY-MM -> Σret
    for (let i=0;i<rets.length;i++){
      const ym = (days[i+1]||'').slice(0,7);
      bucket.set(ym, (bucket.get(ym)||0)+rets[i]);
    }
    const arr=[...bucket.values()]; if(!arr.length) return 0;
    const win=arr.filter(v=>v>0).length;
    return win/arr.length;
  }
  async function renderBenchmark(K){
    try{
      const info=await loadBenchmarkTextFromParams();
      const tb=$('#kpiOptBench tbody');
      if (!tb){ return; }
      if (!info.raw) { tb.innerHTML=`<tr><td colspan="4">— 尚未連結基準（how:${info.how}，src:${info.src||'—'}${info.err?`, err:${info.err}`:''}）</td></tr>`; return; }
      const rowsB = window.ETF_ENGINE.parseCanon(info.raw);
      if (!rowsB.length){ tb.innerHTML=`<tr><td colspan="4">— 基準解析為空（how:${info.how}，src:${info.src}）</td></tr>`; return; }

      const S = { days:K.equity.days, eqs:K.equity.series };
      const srets=[]; for(let i=1;i<S.eqs.length;i++){ const a=S.eqs[i-1], b=S.eqs[i]; if(a>0) srets.push(b/a-1); }

      const B = seriesFromRows(rowsB);
      const { a:retsS, b:retsB } = alignRets(S.days, srets, B.days, B.rets);
      if (!retsS.length){ tb.innerHTML=`<tr><td colspan="4">— 基準與策略日期無交集（how:${info.how}，src:${info.src}）</td></tr>`; return; }

      const ms=meanStd(retsS).m, mb=meanStd(retsB).m;
      const annS=ms*252, annB=mb*252;

      const ex = retsS.map((v,i)=>v-retsB[i]);
      const te = meanStd(ex).s * Math.sqrt(252);
      const ir = te>0 ? (annS - annB)/te : 0;

      const { alpha, beta, r2 } = olsAlphaBeta(retsS, retsB);
      const alphaAnn = alpha*252;
      const treynor = beta!==0 ? (annS - CFG.rf)/beta : 0;

      const upIdx=retsB.map((v,i)=>v>0?i:-1).filter(i=>i>=0);
      const dnIdx=retsB.map((v,i)=>v<0?i:-1).filter(i=>i>=0);
      const upCap = upIdx.length ? (upIdx.map(i=>retsS[i]).reduce((a,b)=>a+b,0)/upIdx.length) /
                                   (upIdx.map(i=>retsB[i]).reduce((a,b)=>a+b,0)/upIdx.length) : 0;
      const dnCap = dnIdx.length ? (dnIdx.map(i=>retsS[i]).reduce((a,b)=>a+b,0)/dnIdx.length) /
                                   (Math.abs(dnIdx.map(i=>retsB[i]).reduce((a,b)=>a+b,0)/dnIdx.length)) : 0;

      const mHit = monthHitRate(S.days, srets);

      const rows = [
        ['Alpha (年化)', fmtPct(alphaAnn), 'OLS 截距 × 252', `how:${info.how}`],
        ['Beta',         beta.toFixed(3),  'OLS 斜率',        `how:${info.how}`],
        ['Information Ratio (IR)', ir.toFixed(3), '(年化超額/TE)', `how:${info.how}`],
        ['Tracking Error (TE)',    fmtPct(te),    'σ(Rs - Rb) × √252', `how:${info.how}`],
        ['R²',           r2.toFixed(3),   '解釋度',           `how:${info.how}`],
        ['上行捕捉 (Up Capture)',   (upCap).toFixed(2)+'x', '基準>0期間平均比率', `how:${info.how}`],
        ['下行捕捉 (Down Capture)', (dnCap).toFixed(2)+'x', '基準<0期間平均比率(越小越好)', `how:${info.how}`],
        ['Treynor',      (treynor).toFixed(3), '（年化報酬 - Rf）/ Beta', `how:${info.how}`],
        ['月勝率',       fmtPct(mHit),    '正報酬月份比例',   `how:${info.how}`]
      ];
      fillRows('#kpiOptBench tbody', rows);
    }catch(err){
      console.error('[BENCH ERROR]', err);
      const tb=$('#kpiOptBench tbody'); if (tb) tb.innerHTML = `<tr><td colspan="4">— 基準計算錯誤：${(err?.message||String(err))}</td></tr>`;
    }
  }

  // ========= 主流程 =========
  async function boot(){
    try{
      set('從 Supabase 讀取清單…');
      const paramFile = url.searchParams.get('file');
      let latest=null, list=[];
      if (paramFile){
        latest={ name:paramFile.split('/').pop()||'00909.txt', fullPath:paramFile, from:'url' };
      }else{
        list=(await listCandidates()).filter(f=>CFG.want.test(f.name)||CFG.want.test(f.fullPath));
        list.sort((a,b)=>{ const sa=lastDateScore(a.name), sb=lastDateScore(b.name);
          if(sa!==sb) return sb-sa; if(a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt; return (b.size||0)-(a.size||0); });
        latest=list[0];
      }
      if(!latest){ set('找不到檔名含「00909」的 TXT（可用 ?file= 指定）。', true); return; }
      $('#latestName')?.textContent = latest.name;

      set('下載最新檔…');
      const latestUrl = latest.from==='url'? latest.fullPath : pubUrl(latest.fullPath);
      const txt = await fetchText(latestUrl);

      set('解析與回測…');
      const rows = window.ETF_ENGINE.parseCanon(txt);
      if(!rows.length){ set('TXT 內無可解析的交易行。', true); return; }

      const start8=rows[0].day, end8=rows.at(-1).day;
      $('#periodText')?.textContent = `期間：${start8} 開始到 ${end8} 結束`;

      // 原始 execs → 最佳化 execs
      const bt = backtest(rows);
      const optExecs = buildOptimizedExecs(bt.execs);

      // 目前持有（僅在仍有部位）
      renderLastOpenBuyFromOpt(optExecs);

      // 週次圖（以 optExecs）
      renderWeeklyChartFromOpt(optExecs);

      // 明細表（以 optExecs）
      renderOptTable(optExecs);

      // KPI（以 optExecs）
      const K = computeKPIFromOpt(optExecs);
      if (K){
        renderKPI(K);
        await renderBenchmark(K);
      }

      // 基準按鈕（保留但禁用）
      const btn = $('#btnSetBaseline'); if (btn) btn.disabled = true;

      set('完成。');
    }catch(err){
      console.error('[00909 ERROR]', err);
      set('初始化失敗：' + (err?.message || String(err)), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
