# Create a full-length JS file with comprehensive functionality for the user's 00909 page.
# The script is designed to be dropped in as `etf-00909.js` and works with the previously supplied HTML.
# It assumes `Chart` (Chart.js) and `window.ETF_ENGINE` (from etf-engine.js) are already loaded.

from textwrap import dedent

js = dedent(r"""
/* etf-00909.js — 00909 專用：以「最佳化交易明細 (optExecs)」為唯一績效口徑
 * 功能：
 *  1) 解析 Supabase 最新 00909 TXT → window.ETF_ENGINE.parseCanon / backtest 取得 base execs
 *  2) 依分段(多買一賣) → 1/1/2（可降檔）→ 生成 optExecs（未平倉 BUY 也保留）
 *  3) 「目前持有」：若仍有持倉，逐筆列出所有未平倉 BUY（逐行）、並顯示持有數量
 *  4) 週次圖：以 optExecs SELL 的 pnlFull 做週別聚合，並繪製累積淨利折線
 *  5) KPI 全套（報酬/風險/效率/穩定/成本 + 建議清單），完全以 optExecs 計算
 *  6) 基準相關（Alpha 年化/Jensen、Beta、IR、TE、R²、Upside/Downside Capture、Treynor）
 *     支援 ?benchmark=0050|TWII 或 ?benchfile=benchmarks/xxx.csv 或 ?benchurl=https://...csv
 *  7) 最佳化交易明細表：列出 optExecs（含未平倉 BUY）
 *
 * 版本：kpi-opt-v12-file
 */
(function(){
  "use strict";

  /* ---------- 小工具 ---------- */
  const $ = s => document.querySelector(s);
  const DAY_MS = 24*60*60*1000;

  const fmtInt = v => Number.isFinite(v) ? Math.round(v).toLocaleString() : "—";
  const fmtPct = v => (v==null || !Number.isFinite(v)) ? "—" : (v*100).toFixed(2) + "%";
  const tsPretty = ts14 => ts14 ? `${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}` : "—";
  const rateText = t => t==="Strong"?"Strong (強)":(t==="Adequate"?"Adequate (可)":"Improve (弱)");
  const rateHtml = t => `<span class="${t==='Strong'?'rate-strong':(t==='Adequate'?'rate-adequate':'rate-improve')}">${rateText(t)}</span>`;
  const setStatus = (m,bad=false)=>{ const el = $('#autostatus')||$('#message'); if(el){ el.textContent=m; el.style.color=bad?'#c62828':'#666'; } };
  const qp = k => new URL(location.href).searchParams.get(k);

  /* ---------- 設定 ---------- */
  const CFG = {
    symbol:"00909", bucket:"reports", want:/00909/i,
    feeRate:0.001425, taxRate:0.001, minFee:20,
    unitShares:1000, rf:0.00, initialCapital:1_000_000,
    manifestPath:"manifests/etf-00909.json"
  };
  const OPT = { capital:1_000_000, unit:CFG.unitShares, legs:[1,1,2] };

  // chips
  const chip = (id,v)=>{ const el=$(`#${id}`); if(el) el.textContent=v; };
  chip("feeRateChip",(CFG.feeRate*100).toFixed(4)+"%");
  chip("taxRateChip",(CFG.taxRate*100).toFixed(3)+"%");
  chip("minFeeChip",String(CFG.minFee));
  chip("unitChip",String(CFG.unitShares));
  chip("slipChip","0");
  chip("rfChip",(CFG.rf*100).toFixed(2)+"%");

  /* ---------- Supabase ---------- */
  const SUPABASE_URL="https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_KEY="sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t"; // public
  const sb = window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{ global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) } });
  const pubUrl = path => { const {data} = sb.storage.from(CFG.bucket).getPublicUrl(path); return data?.publicUrl || "#"; };

  async function listOnce(prefix){
    const p=(prefix && !prefix.endsWith("/"))?(prefix+"/"):(prefix||"");
    const {data,error}=await sb.storage.from(CFG.bucket).list(p,{limit:1000,sortBy:{column:"name",order:"asc"}});
    if(error) throw new Error(error.message);
    return (data||[]).map(x=>({ name:x.name, fullPath:p+x.name, updatedAt:x.updated_at?Date.parse(x.saved_at||x.updated_at):0 }));
  }
  async function listCandidates(){
    const pref=qp("prefix")||"";
    const arr=await listOnce(pref);
    return arr.filter(f=>CFG.want.test(f.name)||CFG.want.test(f.fullPath||""));
  }
  async function fetchText(url){
    const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const buf=await r.arrayBuffer();
    const encs=["utf-8","utf-16le","utf-16be","utf-32le","utf-32be","big5","windows-1252"];
    for(const e of encs){ try{ return new TextDecoder(e).decode(buf).replace(/\ufeff/g,""); }catch{} }
    return new TextDecoder().decode(buf);
  }

  /* ---------- base → optExecs ---------- */
  const feePack=(px,qty,isSell)=>{
    const gross=px*qty;
    const fee=Math.max(CFG.minFee, gross*CFG.feeRate);
    const tax=isSell? gross*CFG.taxRate : 0;
    return {gross,fee,tax};
  };
  const buyCostLots=(px,lots)=>{
    const shares=lots*OPT.unit;
    const f=feePack(px,shares,false);
    return { shares, gross:f.gross, fee:f.fee, cost:f.gross+f.fee };
  };
  const splitSegments=execs=>{
    const segs=[], cur=[];
    for(const e of execs){ cur.push(e); if(e.side==="SELL"){ segs.push(cur.slice()); cur.length=0; } }
    if(cur.length) segs.push(cur);
    return segs;
  };
  function buildOptExecs(baseExecs){
    const segs=splitSegments(baseExecs);
    const out=[]; let cumP=0;
    for(const seg of segs){
      const buys=seg.filter(e=>e.side==="BUY");
      const sell=seg.find(e=>e.side==="SELL");
      if(!buys.length) continue;

      // 計算每段可承擔的最大 lots，1/1/2 規劃（可降檔）
      const oneCost = buyCostLots(buys[0].price,1).cost;
      let maxLots = Math.floor(OPT.capital / Math.max(1,oneCost));
      if(maxLots<=0) continue;

      const rawPlan=[1,1,2];
      const plan=[];
      for(let i=0;i<Math.min(buys.length,3);i++){
        const base=Math.floor(maxLots/4);
        plan.push(i<2? Math.max(1,base) : Math.max(1, 2*base));
      }

      let held=0, avg=0, accCost=0, units=0;
      for(let i=0;i<Math.min(buys.length,3);i++){
        const b=buys[i];
        const unitC=buyCostLots(b.price,1).cost;
        const affordable=Math.floor((OPT.capital-accCost)/Math.max(1,unitC));
        let lots=Math.min(plan[i], affordable);
        if(lots<=0) break;
        const bc=buyCostLots(b.price,lots);
        accCost+=bc.cost; held+=bc.shares; units+=lots;
        avg=(avg*(held-bc.shares) + b.price*bc.shares)/(held||1);

        out.push({
          side:"BUY", ts:b.ts, tsMs:b.tsMs, price:b.price, avgCost:avg,
          shares:bc.shares, buyAmount:bc.gross, sellAmount:0,
          fee:bc.fee, tax:0, cost:bc.cost, cumCost:accCost,
          pnlFull:null, retPctUnit:null, cumPnlFull:cumP
        });
      }

      if(sell && held>0){
        const sp=feePack(sell.price,held,true);
        const pnl=sp.gross - (accCost + sp.fee + sp.tax);
        const ret= (units>0 && accCost>0)? (pnl/(accCost/units)) : null;
        cumP+=pnl;
        out.push({
          side:"SELL", ts:sell.ts, tsMs:sell.tsMs, price:sell.price, avgCost:avg,
          shares:held, buyAmount:0, sellAmount:sp.gross,
          fee:sp.fee, tax:sp.tax, cost:0, cumCost:accCost,
          pnlFull:pnl, retPctUnit:ret, cumPnlFull:cumP
        });
      }
    }
    out.sort((a,b)=>a.tsMs-b.tsMs);
    return out;
  }

  /* ---------- 週次圖：以 SELL 的 pnlFull 聚合 ---------- */
  let weeklyChart=null;
  function renderWeeklyChart(optExecs){
    const box=$('#weeklyCard'), cvs=$('#chWeekly');
    if(!box||!cvs) return;
    const agg=weeklyAgg(optExecs);
    if(!agg.labels.length){ box.style.display='none'; return; }
    box.style.display='';
    if(weeklyChart) weeklyChart.destroy();
    weeklyChart=new Chart(cvs,{
      type:'bar',
      data:{
        labels:agg.labels,
        datasets:[
          { type:'bar', label:'每週獲利（浮動長條）', data: agg.cum.map((v,i)=>[i>0?agg.cum[i-1]:0, v]), borderWidth:1, backgroundColor:'rgba(13,110,253,0.30)', borderColor:'#0d6efd' },
          { type:'line',label:'累積淨利', data: agg.cum, borderWidth:2, borderColor:'#f43f5e', tension:0.2, pointRadius:0 }
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false, parsing:{ yAxisKey:undefined },
        plugins:{ legend:{ display:true } },
        scales:{ y:{ suggestedMin:0, suggestedMax: Math.max(1, Math.max(...agg.cum)*1.05) }, x:{ ticks:{ maxTicksLimit:12 } } }
      }
    });
  }
  function weeklyAgg(optExecs){
    const m=new Map(), order=[];
    for(const e of optExecs){
      if(e.side!=='SELL' || !Number.isFinite(e.pnlFull)) continue;
      const d=new Date(e.tsMs); const wk=weekStart(d);
      if(!m.has(wk)){ m.set(wk,0); order.push(wk); }
      m.set(wk, m.get(wk)+e.pnlFull);
    }
    const labels=order;
    const weekly=labels.map(k=>m.get(k)||0);
    const cum=[]; let s=0; for(const v of weekly){ s+=v; cum.push(s); }
    return { labels, weekly, cum };
    function weekStart(dt){ const dow=(dt.getUTCDay()+6)%7; const u=new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate()-dow)); return u.toISOString().slice(0,10); }
  }

  /* ---------- 目前持有：未平倉段的所有 BUY 逐行 ---------- */
  function renderCurrentPosition(optExecs){
    const bar=$('#lastBuyBar'); if(!bar) return;
    let lastSell=-1;
    for(let i=optExecs.length-1;i>=0;i--){ if(optExecs[i].side==='SELL'){ lastSell=i; break; } }
    const lines=[]; let held=0;
    for(let i=Math.max(0,lastSell+1); i<optExecs.length; i++){
      const e=optExecs[i];
      if(e.side==='BUY'){ lines.push(`買進　${tsPretty(e.ts)}　成交價格 <b>${Number(e.price).toFixed(2)}</b>　成交數量 <b>${fmtInt(e.shares)}</b>`); held += (e.shares||0); }
    }
    if(held<=0 || !lines.length){ bar.style.display='none'; return; }
    bar.innerHTML = `目前持有：<br>${lines.join('<br>')}　持有數量 <b>${fmtInt(held)}</b>`;
    bar.style.display='';
  }

  /* ---------- KPI（以 optExecs 計算） ---------- */
  const BANDS={
    CAGR:{strong:0.15, adequate:0.05},
    MaxDD:{strong:-0.10, adequate:-0.25},
    Vol:{strong:0.20, adequate:0.35},
    Down:{strong:0.15, adequate:0.30},
    Sharpe:{strong:1.0, adequate:0.5},
    Sortino:{strong:1.5, adequate:0.75},
    Calmar:{strong:1.0, adequate:0.3},
    RtVol:{strong:1.0, adequate:0.5},
    PF:{strong:1.5, adequate:1.0},
    MCL:{strong:5, adequate:10},
    CostR:{strong:0.001, adequate:0.003}, // 注意：此處為比例（0.1%/0.3%）
    Omega:{strong:1.5, adequate:1.0}
  };
  function computeKPIFromOpt(optExecs){
    let equity=CFG.initialCapital, cumP=0, gb=0, gs=0, feeSum=0, taxSum=0;
    const timeline=[], tradePnls=[];
    for(const e of optExecs){
      if(e.side==='BUY'){ equity -= (e.cost||0); gb += (e.buyAmount||0); feeSum += (e.fee||0); }
      else{ equity += (e.sellAmount||0) - (e.fee||0) - (e.tax||0); gs += (e.sellAmount||0); feeSum += (e.fee||0); taxSum += (e.tax||0); if(Number.isFinite(e.pnlFull)) { tradePnls.push(e.pnlFull); cumP += e.pnlFull; } }
      timeline.push({t:e.tsMs, v:equity});
    }
    // 日末權益 → 日報酬
    const dayMap=new Map(); for(const p of timeline){ const d=new Date(p.t).toISOString().slice(0,10); dayMap.set(d,p.v); }
    const days=[...dayMap.keys()].sort(); const eqs=days.map(d=>dayMap.get(d)); const rets=[];
    for(let i=1;i<eqs.length;i++){ const a=eqs[i-1], b=eqs[i]; if(a>0) rets.push(b/a-1); }

    const t0=days.length? Date.parse(days[0]): Date.now();
    const t1=days.length? Date.parse(days[days.length-1]): t0;
    const years=Math.max(1/365,(t1-t0)/(365*DAY_MS));
    const totalRet = cumP / CFG.initialCapital;
    const CAGR = Math.pow(1+totalRet, 1/years) - 1;

    const mean= rets.length? rets.reduce((a,b)=>a+b,0)/rets.length : 0;
    const sd  = rets.length>1? Math.sqrt(rets.reduce((s,x)=>s+(x-mean)*(x-mean),0)/rets.length) : 0;
    const annRet = mean * 252;
    const vol    = sd   * Math.sqrt(252);
    const neg = rets.filter(x=>x<0);
    const mNeg= neg.length? neg.reduce((a,b)=>a+b,0)/neg.length : 0;
    const sdNeg= neg.length>1? Math.sqrt(neg.reduce((s,x)=>s+(x-mNeg)*(x-mNeg),0)/neg.length) : 0;
    const down = sdNeg * Math.sqrt(252);
    const sharpe = vol>0 ? (annRet - CFG.rf)/vol : 0;
    const sortino= down>0 ? (annRet - CFG.rf)/down : 0;

    // Drawdown / TU / Recovery / UI
    let peak=eqs[0]||CFG.initialCapital, maxDD=0, curU=0, maxU=0, rec=0, recFound=false, troughIdx=0, peakIdx=0;
    const ddSeries=[];
    for(let i=0;i<eqs.length;i++){
      const v=eqs[i];
      if(v>peak){ peak=v; }
      const dd=(v-peak)/peak; ddSeries.push(dd);
      if(dd<maxDD){ maxDD=dd; troughIdx=i; peakIdx=eqs.findIndex((x,ix)=> ix<=i && x===peak); }
      if(dd<0){ curU++; maxU=Math.max(maxU,curU); } else curU=0;
    }
    if(peakIdx<troughIdx){
      const refPeak=eqs[peakIdx];
      for(let i=troughIdx;i<eqs.length;i++){ if(eqs[i]>=refPeak){ rec=i-troughIdx; recFound=true; break; } }
      if(!recFound) rec = Math.max(0, eqs.length-1 - troughIdx);
    }
    const onlyNeg = ddSeries.filter(x=>x<0);
    const UI = onlyNeg.length? Math.sqrt(onlyNeg.reduce((s,x)=>s+x*x,0)/onlyNeg.length) : 0;

    // PF / Payoff / MCL
    const wins=tradePnls.filter(x=>x>0), losses=tradePnls.filter(x=>x<0);
    const PF = (Math.abs(losses.reduce((a,b)=>a+b,0))>0)? (wins.reduce((a,b)=>a+b,0) / Math.abs(losses.reduce((a,b)=>a+b,0))) : (wins.length?99:0);
    const hit= tradePnls.length? wins.length/tradePnls.length : 0;
    const wavg = wins.length? wins.reduce((a,b)=>a+b,0)/wins.length : 0;
    const lavg = losses.length? Math.abs(losses.reduce((a,b)=>a+b,0))/losses.length : 0;
    const payoff = lavg>0 ? (wavg/lavg) : (wavg>0?99:0);
    let MCL=0, cc=0; for(const p of tradePnls){ if(p<0){ cc++; MCL=Math.max(MCL,cc);} else cc=0; }

    const totalFees = feeSum, totalTaxes = taxSum, totalCost = totalFees+totalTaxes;
    const turnover = (gb+gs)/CFG.initialCapital;
    const avgTradeValue = (gb+gs)/Math.max(1, tradePnls.length);
    const rtVol = vol>0 ? annRet/vol : 0;
    const Omega = (rets.filter(x=>x>0).length) / Math.max(1, rets.filter(x=>x<0).length);
    const Calmar = Math.abs(maxDD)>0 ? CAGR/Math.abs(maxDD) : 0;

    return {
      period:{ days, start:days[0]||"", end:days[days.length-1]||"", years },
      equity:{ series:eqs, ddSeries },
      returns:{ daily:rets, annRet:annRet, vol, downside:down, VaR95:var95(rets), CVaR95:cvar95(rets), Omega },
      pnl:{ trades:tradePnls, total:cumP, maxWin:Math.max(...tradePnls,0), maxLoss:Math.min(...tradePnls,0) },
      risk:{ maxDD, TU_days:maxU, Rec_days:rec, UI, Martin: UI>0? (annRet/UI) : 0, MCL },
      ratios:{ totalRet, CAGR, sharpe, sortino, calmar:Calmar, rtVol, PF, hit, payoff },
      cost:{ totalFees, totalTaxes, totalCost, grossBuy:gb, grossSell:gs, turnover, avgTradeValue, costRatio:(gb+gs>0? totalCost/(gb+gs) : 0) }
    };

    function var95(a){ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const i=Math.max(0, Math.floor(0.05*(s.length-1))); return s[i]; }
    function cvar95(a){ const s=[...a].sort((x,y)=>x-y); const i=Math.max(0, Math.floor(0.05*(s.length-1))); const t=s.slice(0,i+1); return t.length? t.reduce((p,c)=>p+c,0)/t.length : null; }
  }

  function renderKPI(K){
    $('#kpiOptCard').style.display='';
    const fillRows=(sel, rows)=>{ const tb=$(sel+' tbody'); if(!tb) return; tb.innerHTML=''; for(const r of rows){ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${rateHtml(r[3])}</td><td class="subtle">${r[4]||'—'}</td>`; tb.appendChild(tr);} };

    const ret=[
      ['總報酬 (Total Return)', `${fmtInt(K.pnl.total)}（${fmtPct(K.ratios.totalRet)}）`, '期末/期初 - 1', (K.ratios.totalRet>0?'Strong':'Improve'), '≥0%'],
      ['CAGR 年化', fmtPct(K.ratios.CAGR), '長期年化', (K.ratios.CAGR>=BANDS.CAGR.strong?'Strong':(K.ratios.CAGR>=BANDS.CAGR.adequate?'Adequate':'Improve')), '≥15% / ≥5%'],
      ['Arithmetic 年化', fmtPct(K.returns.annRet), '日均×252', (K.returns.annRet>=0.20?'Strong':(K.returns.annRet>=0.05?'Adequate':'Improve')), '≥20% / ≥5%'],
      ['平均每筆淨利', fmtInt(K.pnl.trades.length? K.pnl.total/K.pnl.trades.length : 0), '交易損益均值', (K.pnl.total>0?'Strong':'Improve'), '> 0'],
      ['勝率 (Hit Ratio)', fmtPct(K.ratios.hit), '獲利筆數/總筆數', (K.ratios.hit>=BANDS.Hit.strong?'Strong':(K.ratios.hit>=BANDS.Hit.adequate?'Adequate':'Improve')), '≥55% / ≥45%'],
      ['單筆最大獲利/虧損', `${fmtInt(K.pnl.maxWin)} / ${fmtInt(K.pnl.maxLoss)}`, '極值', 'Adequate', '—']
    ];
    fillRows('#kpiOptReturn', ret);

    const risk=[
      ['最大回撤 (MaxDD)', fmtPct(K.risk.maxDD), '峰值到谷底', (K.risk.maxDD<=BANDS.MaxDD.strong?'Strong':(K.risk.maxDD<=BANDS.MaxDD.adequate?'Adequate':'Improve')), '≥-10% / ≥-25%'],
      ['水下時間 (TU)', `${K.risk.TU_days} 天`, '在水下的最長天數', (K.risk.TU_days<=BANDS.TU_days?.strong? 'Strong' : (K.risk.TU_days<=BANDS.TU_days?.adequate? 'Adequate' : 'Improve')), '≤45 / ≤120'],
      ['回本時間 (Recovery)', `${K.risk.Rec_days} 天`, '回到新高所需天數', (K.risk.Rec_days<=BANDS.Rec_days?.strong? 'Strong' : (K.risk.Rec_days<=BANDS.Rec_days?.adequate? 'Adequate' : 'Improve')), '≤45 / ≤90'],
      ['波動率 (Volatility)', fmtPct(K.returns.vol), '年化標準差', (K.returns.vol<=BANDS.Vol.strong?'Strong':(K.returns.vol<=BANDS.Vol.adequate?'Adequate':'Improve')), '≤20% / ≤35%'],
      ['下行波動 (Downside Dev)', fmtPct(K.returns.downside), '只計下行波動年化', (K.returns.downside<=BANDS.Down.strong?'Strong':(K.returns.downside<=BANDS.Down.adequate?'Adequate':'Improve')), '≤15% / ≤30%'],
      ['Ulcer Index (UI)', fmtPct(K.risk.UI), '回撤平方均根', (K.risk.UI<=BANDS.UI?.strong? 'Strong' : (K.risk.UI<=BANDS.UI?.adequate? 'Adequate':'Improve')), '≤5% / ≤12%'],
      ['Martin Ratio', (K.risk.Martin).toFixed(2), '年化報酬/UI', (K.risk.Martin>=BANDS.Martin?.strong? 'Strong' : (K.risk.Martin>=BANDS.Martin?.adequate? 'Adequate' : 'Improve')), '≥0.8 / ≥0.3'],
      ['VaR 95% (1日)', fmtPct(K.returns.VaR95), '95%一日風險', (K.returns.VaR95>=-0.02?'Strong':(K.returns.VaR95>=-0.04?'Adequate':'Improve')), '>-2% / >-4%'],
      ['CVaR 95% (1日)', fmtPct(K.returns.CVaR95), '超過VaR的平均虧損', (K.returns.CVaR95>=-0.03?'Strong':(K.returns.CVaR95>=-0.06?'Adequate':'Improve')), '>-3% / >-6%']
    ];
    fillRows('#kpiOptRisk', risk);

    const eff=[
      ['Sharpe', (K.ratios.sharpe).toFixed(2), '風險調整報酬', (K.ratios.sharpe>=BANDS.Sharpe.strong?'Strong':(K.ratios.sharpe>=BANDS.Sharpe.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.5'],
      ['Sortino', (K.ratios.sortino).toFixed(2), '下行風險報酬', (K.ratios.sortino>=BANDS.Sortino.strong?'Strong':(K.ratios.sortino>=BANDS.Sortino.adequate?'Adequate':'Improve')), '≥1.5 / ≥0.75'],
      ['Calmar', (Math.abs(K.risk.maxDD)>0? (K.ratios.CAGR/Math.abs(K.risk.maxDD)) : 0).toFixed(2), 'CAGR / |MaxDD|', (Math.abs(K.risk.maxDD)>0?(K.ratios.CAGR/Math.abs(K.risk.maxDD)>=1?'Strong':(K.ratios.CAGR/Math.abs(K.risk.maxDD)>=0.3?'Adequate':'Improve')):'Improve'), '≥1.0 / ≥0.3'],
      ['Reward/Vol', (K.ratios.rtVol).toFixed(2), '年化報酬/波動', (K.ratios.rtVol>=BANDS.RtVol.strong?'Strong':(K.ratios.rtVol>=BANDS.RtVol.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.5'],
      ['Profit Factor (PF)', (K.ratios.PF).toFixed(2), '總獲利/總虧損', (K.ratios.PF>=BANDS.PF.strong?'Strong':(K.ratios.PF>=BANDS.PF.adequate?'Adequate':'Improve')), '≥1.5 / ≥1.0'],
      ['Payoff Ratio', (K.ratios.payoff).toFixed(2), '均獲利/均虧損', (K.ratios.payoff>=1.5?'Strong':(K.ratios.payoff>=1?'Adequate':'Improve')), '≥1.5 / ≥1.0'],
      ['最大連敗 (MCL)', K.risk.MCL, '最大連續虧損次數', (K.risk.MCL<=BANDS.MCL.strong?'Strong':(K.risk.MCL<=BANDS.MCL.adequate?'Adequate':'Improve')), '≤5 / ≤10']
    ];
    fillRows('#kpiOptEff', eff);

    const stab=[
      ['偏態 (Skewness)', '—', '分配偏度(>0偏右尾)', 'Adequate', '> 0'],
      ['峰度 (Kurtosis)', '—', '分配峰度(≈3常態;>10重尾)', 'Adequate', '≤10']
    ];
    fillRows('#kpiOptStab', stab);

    const cost=[
      ['總費用(手續費+稅)', fmtInt(K.cost.totalCost), '所有賣出筆累計', 'Adequate', '—'],
      ['費用比 (Cost Ratio)', fmtPct(K.cost.costRatio), '(費用/成交額)', (K.cost.costRatio<=BANDS.CostR.strong?'Strong':(K.cost.costRatio<=BANDS.CostR.adequate?'Adequate':'Improve')), '<0.10% / <0.30%'],
      ['成交額週轉率 (Turnover)', (K.cost.turnover).toFixed(2)+'x', '成交額/本金', (K.cost.turnover<=BANDS.Turnover?.strong? 'Strong' : (K.cost.turnover<=BANDS.Turnover?.adequate? 'Adequate':'Improve')), '1~2x'],
      ['筆均成交額 (Avg Trade Value)', fmtInt(K.cost.avgTradeValue), '成交額/筆數', (K.cost.avgTradeValue>=100000?'Strong':(K.cost.avgTradeValue>=30000?'Adequate':'Improve')), '≥100k / ≥30k'],
      ['買入總額 / 賣出總額', `${fmtInt(K.cost.grossBuy)} / ${fmtInt(K.cost.grossSell)}`, '流動性利用', 'Adequate', '—'],
      ['Omega(0%)', fmtPct(K.returns.Omega), 'P(R>0)/P(R<0)', (K.returns.Omega>=BANDS.Omega.strong?'Strong':(K.returns.Omega>=BANDS.Omega.adequate?'Adequate':'Improve')), '≥1.5 / ≥1.0'],
      ['MAR (CAGR/MaxDD)', (Math.abs(K.risk.maxDD)>0?(K.ratios.CAGR/Math.abs(K.risk.maxDD)):0).toFixed(2), '等同 Calmar', (Math.abs(K.risk.maxDD)>0 && (K.ratios.CAGR/Math.abs(K.risk.maxDD))>=BANDS.MAR?.strong? 'Strong' : (Math.abs(K.risk.maxDD)>0 && (K.ratios.CAGR/Math.abs(K.risk.maxDD))>=BANDS.MAR?.adequate? 'Adequate':'Improve')), '≥1.0 / ≥0.3']
    ];
    fillRows('#kpiOptCost', cost);

    // 建議清單
    const collect=(rows)=>rows.map(r=>({n:r[0],v:r[1],d:r[2],t:r[3],b:r[4]}));
    const sugg = collect(ret).concat(collect(risk),collect(eff),collect(stab),collect(cost))
      .filter(x=>x.t!=='Strong')
      .sort((a,b)=> (a.t==='Improve'?0:1) - (b.t==='Improve'?0:1));
    fillRows('#kpiOptSuggest', sugg.map(x=>[x.n,x.v,'—',x.t,x.b]));
  }

  /* ---------- 基準：讀取 + 計算 ---------- */
  async function loadBenchmark(days){
    const tag=(qp('benchmark')||'').toUpperCase();
    const benchFile=qp('benchfile')||'';
    const benchUrl =qp('benchurl')||'';
    let src=null;
    if(benchUrl) src=benchUrl;
    else if(benchFile) src=pubUrl(benchFile);
    else if(tag) src=pubUrl(`benchmarks/${tag}.csv`);
    if(!src) return {ok:false, reason:'尚未連結基準（?benchmark=0050 / ?benchmark=TWII / ?benchfile= / ?benchurl=）'};
    const text=await fetchText(src);
    const lines=text.replace(/\r\n?/g,"\n").split("\n").filter(Boolean);
    if(lines.length<2) return {ok:false, reason:'基準檔無資料行'};
    const head=lines[0].toLowerCase();
    const arr=[]; let prev=null;
    if(head.includes('ret')){
      for(let i=1;i<lines.length;i++){ const [d,r]=lines[i].split(/[,\t ]+/); if(/^\d{4}-\d{2}-\d{2}$/.test(d)||/^\d{8}$/.test(d)){ const dd= /^\d{8}$/.test(d)? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`:d; const rv=parseFloat(r); if(!isNaN(rv)) arr.push({d:dd,r:rv}); } }
    }else{
      for(let i=1;i<lines.length;i++){ const [d,c]=lines[i].split(/[,\t ]+/); const px=parseFloat(c); if((/^\d{4}-\d{2}-\d{2}$/.test(d)||/^\d{8}$/.test(d)) && px>0){ const dd= /^\d{8}$/.test(d)? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`:d; if(prev!=null) arr.push({d:dd,r:px/prev-1}); prev=px; } }
    }
    const map=new Map(arr.map(x=>[x.d,x.r]));
    const br=[]; for(const d of days){ if(map.has(d)) br.push(map.get(d)); }
    if(br.length<5) return {ok:false, reason:'對齊後可用日數 < 5'};
    return {ok:true, rets:br};
  }

  function renderBenchmarkCard(days, stratDaily){
    const tb=$('#kpiOptBench tbody'); if(!tb) return;
    tb.innerHTML='<tr><td colspan="4">— 載入基準中…</td></tr>';
    (async()=>{
      const info=await loadBenchmark(days);
      if(!info.ok){ tb.innerHTML=`<tr><td colspan="4">— ${info.reason}</td></tr>`; return; }
      // align
      const n=Math.min(stratDaily.length, info.rets.length);
      const s=stratDaily.slice(-n), b=info.rets.slice(-n);
      if(n<5){ tb.innerHTML='<tr><td colspan="4">— 基準樣本不足</td></tr>'; return; }
      // IR & TE
      const active=s.map((v,i)=>v-b[i]);
      const meanA= active.reduce((a,c)=>a+c,0)/n;
      const sdA  = Math.sqrt(active.reduce((x,c)=>x+(c-meanA)*(c-meanA),0)/n);
      const TE   = sdA*Math.sqrt(252);
      const IR   = TE>0? (meanA*252)/TE : 0;
      // regression
      const mx = b.reduce((a,c)=>a+c,0)/n, my=s.reduce((a,c)=>a+c,0)/n;
      let sxx=0, syy=0, sxy=0; for(let i=0;i<n;i++){ const dx=b[i]-mx, dy=s[i]-my; sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy; }
      const beta = sxx>0? sxy/sxx : 0;
      const alpha= my - beta*mx; const r2 = (sxx>0&&syy>0)? (sxy*sxy)/(sxx*syy) : 0;
      const alphaAnn = alpha*252;
      const treynor  = beta!==0 ? ((my*252)-CFG.rf)/beta : 0;
      // capture
      const upIdx = b.map((v,i)=>[v,i]).filter(p=>p[0]>0).map(p=>p[1]);
      const dnIdx = b.map((v,i)=>[v,i]).filter(p=>p[0]<0).map(p=>p[1]);
      const avg=(ids,arr)=> ids.length? ids.reduce((s,i)=>s+arr[i],0)/ids.length : null;
      const upCap = (upIdx.length && avg(upIdx,b)) ? (avg(upIdx,s)/avg(upIdx,b)) : null;
      const dnCap = (dnIdx.length && avg(dnIdx,b)) ? (avg(dnIdx,s)/avg(dnIdx,b)) : null;

      const rows=[
        ['Alpha (年化 Jensen)', (alphaAnn*100).toFixed(2)+'%', '回歸截距 × 252', '—'],
        ['Beta', beta.toFixed(3), '對市場敏感度', '—'],
        ['Information Ratio (IR)', IR.toFixed(2), '年化超額 / 追蹤誤差', '—'],
        ['Tracking Error (TE)', (TE*100).toFixed(2)+'%', '超額報酬標準差年化', '—'],
        ['R²', r2.toFixed(3), '回歸擬合度', '—'],
        ['Upside Capture', upCap==null?'—':upCap.toFixed(2), '基準上漲日：策略/基準', '—'],
        ['Downside Capture', dnCap==null?'—':dnCap.toFixed(2), '基準下跌日：策略/基準', '—'],
        ['Treynor Ratio', treynor.toFixed(2), '(年化超額)/Beta', '—']
      ];
      tb.innerHTML=''; for(const r of rows){ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td>`; tb.appendChild(tr); }
    })();
  }

  /* ---------- 明細表（optExecs） ---------- */
  function renderOptTable(optExecs){
    const thead=$('#optTable thead'), tbody=$('#optTable tbody'); if(!thead||!tbody) return;
    thead.innerHTML=`<tr>
      <th>種類</th><th>日期</th><th>成交價格</th><th>成本均價</th><th>成交數量</th>
      <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
      <th>成本</th><th>累計成本</th><th>損益</th><th>報酬率</th><th>累計損益</th>
    </tr>`;
    tbody.innerHTML='';
    for(const e of optExecs){
      const tr=document.createElement('tr'); tr.className=e.side==='BUY'?'buy-row':'sell-row';
      tr.innerHTML=`<td>${e.side==='BUY'?'買進':'賣出'}</td>
        <td>${tsPretty(e.ts)}</td><td>${Number(e.price).toFixed(2)}</td>
        <td>${e.avgCost!=null? Number(e.avgCost).toFixed(2):'—'}</td><td>${fmtInt(e.shares||0)}</td>
        <td>${fmtInt(e.buyAmount||0)}</td><td>${fmtInt(e.sellAmount||0)}</td>
        <td>${fmtInt(e.fee||0)}</td><td>${fmtInt(e.tax||0)}</td>
        <td>${fmtInt(e.cost||0)}</td><td>${fmtInt(e.cumCost||0)}</td>
        <td>${e.pnlFull==null?'—':(e.pnlFull>=0?`<span class="pnl-pos">${fmtInt(e.pnlFull)}</span>`:`<span class="pnl-neg">${fmtInt(e.pnlFull)}</span>`)}</td>
        <td>${e.retPctUnit==null?'—':fmtPct(e.retPctUnit)}</td>
        <td>${e.cumPnlFull==null?'—':(e.cumPnlFull>=0?`<span class="pnl-pos">${fmtInt(e.cumPnlFull)}</span>`:`<span class="pnl-neg">${fmtInt(e.cumPnlFull)}</span>`)}</td>`;
      tbody.appendChild(tr);
    }
  }

  /* ---------- 主流程 ---------- */
  document.addEventListener('DOMContentLoaded', async ()=>{
    try{
      setStatus("從 Supabase 讀取清單…");
      const file=qp("file"); let latest=null;
      if(file){ latest={ name:file.split('/').pop()||'00909.txt', fullPath:file, from:'url' }; }
      else{
        const list=await listCandidates();
        list.sort((a,b)=>{
          const sa=maxDateScore(a.name), sb=maxDateScore(b.name);
          if(sa!==sb) return sb-sa;
          if(a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt;
          return 0;
        });
        latest=list[0];
      }
      if(!latest){ setStatus('找不到檔名含「00909」的 TXT（可用 ?file= 指定）',true); return; }
      const nm=$('#latestName'); if(nm) nm.textContent=latest.name;

      setStatus("下載最新檔…");
      const url = latest.from==='url'? latest.fullPath : pubUrl(latest.fullPath);
      const txt = await fetchText(url);

      setStatus("解析與回測…");
      const rows = window.ETF_ENGINE.parseCanon(txt);
      if(!rows.length){ setStatus('TXT 內無可解析的交易行。',true); return; }

      const start8=rows[0].day, end8=rows[rows.length-1].day;
      const pt=$('#periodText'); if(pt) pt.textContent=`期間：${start8} 開始到 ${end8} 結束`;

      const bt = window.ETF_ENGINE.backtest(rows, CFG);
      const optExecs = buildOptExecs(bt.execs);

      renderCurrentPosition(optExecs);
      renderWeeklyChart(optExecs);
      renderOptTable(optExecs);

      const K = computeKPIFromOpt(optExecs);
      renderKPI(K);
      renderBenchmarkCard(K.period.days, K.returns.daily);

      const btn=$('#btnSetBaseline'); if(btn) btn.disabled=true;
      setStatus("完成。");
    }catch(err){
      console.error("[00909 ERROR]", err);
      setStatus("初始化失敗："+(err?.message||String(err)), true);
    }
  });

  /* ---------- 輔助：日期分數 ---------- */
  function maxDateScore(name){
    const m=String(name||'').match(/\b(20\d{6})\b/g);
    if(!m) return 0;
    return Math.max(...m.map(s=>+s));
  }

})();
""")

# Save to file
path = "/mnt/data/etf-00909.js"
with open(path, "w", encoding="utf-8") as f:
    f.write(js)

print(f"Saved full JS to {path}")

