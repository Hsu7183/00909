// etf-00909.js — 00909 專用：以「最佳化交易明細」為唯一口徑（週次圖 / KPI / 基準 / 目前持有 / 明細）
// 版本：kpi-opt-v11
(function(){
  // ========= 小工具 =========
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m,bad=false)=>{ if(status){ status.textContent=m; status.style.color=bad?'#c62828':'#666'; } };
  const fmtInt = n => Math.round(n||0).toLocaleString();
  const fmtPct = v => (v==null||!isFinite(v))?'—':(v*100).toFixed(2)+'%';
  const tsPretty = ts14 => `${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;
  const DAY_MS = 24*60*60*1000;
  const rateHtml = l => `<span class="${l==='Strong'?'rate-strong':(l==='Adequate'?'rate-adequate':'rate-improve')}">${l} ${l==='Strong'?'(強)':l==='Adequate'?'(可)':'(弱)'}</span>`;

  // ========= 參數 =========
  const CFG = {
    symbol:'00909',
    bucket:'reports',
    want:/00909/i,
    feeRate:0.001425,
    taxRate:0.001,
    minFee:20,
    unitShares:1000,
    rf:0.00,
    initialCapital:1_000_000,
    manifestPath:'manifests/etf-00909.json'
  };
  const OPT = { capital:1_000_000, unitShares:CFG.unitShares, ratio:[1,1,2] };

  // chips
  $('#feeRateChip').textContent=(CFG.feeRate*100).toFixed(4)+'%';
  $('#taxRateChip').textContent=(CFG.taxRate*100).toFixed(3)+'%';
  $('#minFeeChip').textContent=String(CFG.minFee);
  $('#unitChip').textContent=String(CFG.unitShares);
  $('#slipChip').textContent='0';
  $('#rfChip').textContent=(CFG.rf*100).toFixed(2)+'%';

  // ========= Supabase =========
  const SUPABASE_URL="https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY="sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{ global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) } });
  const pubUrl=p=>{ const {data}=sb.storage.from(CFG.bucket).getPublicUrl(p); return data?.publicUrl||'#'; };

  async function listOnce(prefix){
    const p=(prefix && !prefix.endsWith('/'))?(prefix+'/'):(prefix||'');
    const {data,error}=await sb.storage.from(CFG.bucket).list(p,{limit:1000,sortBy:{column:'name',order:'asc'}});
    if(error) throw new Error(error.message);
    return (data||[]).map(it=>({name:it.name, fullPath:p+it.name, updatedAt:it.updated_at?Date.parse(it.updated_at):0, size:it.metadata?.size||0}));
  }
  async function listCandidates(){ const u=new URL(location.href); const prefix=u.searchParams.get('prefix')||''; return listOnce(prefix); }
  const lastDateScore=name=>{ const m=String(name).match(/\b(20\d{6})\b/g); return m&&m.length? Math.max(...m.map(s=>+s||0)) : 0; };
  async function fetchText(url){
    const res=await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf=await res.arrayBuffer(); const codes=['big5','utf-8','utf-16le','utf-16be','windows-1252'];
    for(const enc of codes){ try{ return new TextDecoder(enc).decode(buf).replace(/\ufeff/gi,''); }catch{} }
    return new TextDecoder('utf-8').decode(buf);
  }

  // ========= 回測（取原始 execs，後續轉最佳化） =========
  function backtest(rows){ return window.ETF_ENGINE.backtest(rows, CFG); }

  // ========= 週次圖（以 SELL 的 pnlFull 歸屬該週） =========
  let chWeekly=null;
  function weekStartDate(ms){ const d=new Date(ms); const dow=(d.getUTCDay()+6)%7; const s=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-dow)); return s.toISOString().slice(0,10); }
  function buildWeeklyFromOpt(optExecs){
    const m=new Map(), order=[];
    for(const e of optExecs){
      if(e.side!=='SELL'||typeof e.pnlFull!=='number') continue;
      const wk=weekStartDate(e.tsMs);
      if(!m.has(wk)){ m.set(wk,0); order.push(wk); }
      m.set(wk, m.get(wk)+e.pnlFull);
    }
    const labels=order, weekly=labels.map(wk=>m.get(wk)||0);
    const cum=[]; let s=0; for(const v of weekly){ s+=v; cum.push(s); }
    return { labels, weekly, cum };
  }
  function renderWeeklyChartFromOpt(optExecs){
    const box=$('#weeklyCard'), ctx=$('#chWeekly'); if(!ctx) return;
    const W=buildWeeklyFromOpt(optExecs);
    if(!W.labels.length){ box.style.display='none'; return; }
    box.style.display='';
    const maxCum=Math.max(...W.cum,0);
    const floatBars=[]; let prev=0; for(const c of W.cum){ floatBars.push([prev,c]); prev=c; }
    if(chWeekly) chWeekly.destroy();
    chWeekly=new Chart(ctx,{ data:{ labels:W.labels, datasets:[
      {type:'bar',label:'每週獲利（浮動長條）',data:floatBars,borderWidth:1,backgroundColor:'rgba(13,110,253,0.30)',borderColor:'#0d6efd'},
      {type:'line',label:'累積淨利',data:W.cum,borderWidth:2,borderColor:'#f43f5e',tension:0.2,pointRadius:0}
    ]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}}, parsing:{yAxisKey:undefined},
      scales:{ y:{ suggestedMin:0, suggestedMax:Math.max(1,maxCum*1.05) }, x:{ ticks:{ maxTicksLimit:12 } } } });
  }

  // ========= 目前持有（以 optExecs） =========
  function renderCurrentPosition(optExecs){
    const netShares = optExecs.reduce((a,e)=> a + (e.side==='BUY'? e.shares : -e.shares), 0);
    const bar=$('#lastBuyBar'); if(!bar) return;
    if(netShares<=0){ bar.style.display='none'; return; }
    // 找最後一次 SELL 後的所有 BUY（目前仍未平倉）
    let lastSellIdx=-1; for(let i=optExecs.length-1;i>=0;i--){ if(optExecs[i].side==='SELL'){ lastSellIdx=i; break; } }
    const lines=[];
    for(let i=Math.max(0,lastSellIdx+1); i<optExecs.length; i++){
      const e=optExecs[i]; if(e.side==='BUY'){ lines.push(`買進　${tsPretty(e.ts)}　成交價格 <b>${Number(e.price).toFixed(2)}</b>　成交數量 <b>${fmtInt(e.shares)}</b>`); }
    }
    if(!lines.length){ bar.style.display='none'; return; }
    bar.innerHTML = `目前持有：<br>${lines.join('<br>')}　持有數量 <b>${fmtInt(netShares)}</b>`;
    bar.style.display='';
  }

  // ========= 最佳化（本金100萬；1/1/2；資金不足縮量；未平倉保留 BUY） =========
  function splitSegments(execs){ const segs=[]; let cur=[]; for(const e of execs){ cur.push(e); if(e.side==='SELL'){ segs.push(cur); cur=[]; } } if(cur.length) segs.push(cur); return segs; }
  function fees(price, shares, isSell){ const gross=price*shares; const fee=Math.max(CFG.minFee, gross*CFG.feeRate); const tax=isSell? gross*CFG.taxRate : 0; return { gross, fee, tax }; }
  function buyCostLots(price, lots){ const shares=lots*CFG.unitShares; const f=fees(price, shares, false); return { cost:f.gross+f.fee, shares, f }; }
  function buildOptimizedExecs(execs){
    const segs=splitSegments(execs), out=[]; let cumPnlAll=0;
    for(const seg of segs){
      const buys=seg.filter(x=>x.side==='BUY'); const sell=seg.find(x=>x.side==='SELL');
      if(!buys.length) continue;
      const p0=buys[0].price, one=buyCostLots(p0,1).cost;
      let maxLotsTotal=Math.floor(OPT.capital/one); if(maxLotsTotal<=0) continue;
      let q=Math.floor(maxLotsTotal/4); if(q<=0) q=1;
      const n=Math.min(3,buys.length), plan=[q,q,2*q].slice(0,n);
      let remaining=OPT.capital, sharesHeld=0, avgCost=0, cumCost=0, unitCount=plan.reduce((a,b)=>a+b,0);
      for(let i=0;i<n;i++){
        const b=buys[i]; let lots=plan[i];
        const unitC=buyCostLots(b.price,1).cost; let affordable=Math.floor(remaining/unitC);
        if(affordable<=0) break; if(lots>affordable) lots=affordable;
        const bc=buyCostLots(b.price,lots);
        remaining-=bc.cost; cumCost+=bc.cost;
        const newAvg=(sharesHeld*avgCost + b.price*bc.shares)/(sharesHeld+bc.shares||1);
        sharesHeld+=bc.shares; avgCost=newAvg;
        out.push({ side:'BUY', ts:b.ts, tsMs:b.tsMs, price:b.price, avgCost:newAvg, shares:bc.shares,
          buyAmount:bc.f.gross, sellAmount:0, fee:bc.f.fee, tax:0, cost:bc.cost, cumCost,
          pnlFull:null, retPctUnit:null, cumPnlFull:cumPnlAll });
      }
      if(sell && sharesHeld>0){
        const st=fees(sell.price, sharesHeld, true);
        const pnlFull= st.gross - cumCost - (st.fee + st.tax);
        const retPctUnit= (unitCount>0 && cumCost>0)? (pnlFull / (cumCost/unitCount)) : null;
        cumPnlAll+=pnlFull;
        out.push({ side:'SELL', ts:sell.ts, tsMs:sell.tsMs, price:sell.price, avgCost, shares:sharesHeld,
          buyAmount:0, sellAmount:st.gross, fee:st.fee, tax:st.tax, cost:0, cumCost,
          pnlFull, retPctUnit, cumPnlFull:cumPnlAll });
      }
    }
    out.sort((a,b)=> a.tsMs - b.tsMs);
    return out;
  }

  // ========= KPI（以 optExecs；總報酬=ΣpnlFull/本金；年化 = (1+TR)^(1/年) - 1） =========
  const BANDS = {
    CAGR:{strong:0.15, adequate:0.05}, MaxDD:{strong:-0.10, adequate:-0.25}, Vol:{strong:0.20, adequate:0.35},
    Sharpe:{strong:1.0, adequate:0.5}, Sortino:{strong:1.5, adequate:0.75},
    Calmar:{strong:1.0, adequate:0.3}, PF:{strong:1.5, adequate:1.0}, Hit:{strong:0.55, adequate:0.45},
    TU_days:{strong:45, adequate:120}, Rec_days:{strong:45, adequate:90}, MCL:{strong:5, adequate:10},
    Payoff:{strong:1.5, adequate:1.0}, CostRatio:{strong:0.001, adequate:0.003}, Turnover:{strong:1.0, adequate:2.0},
    RtVol:{strong:1.0, adequate:0.5}, MAR:{strong:1.0, adequate:0.3}, Omega:{strong:1.5, adequate:1.0},
    VaR95:{strong:-0.02, adequate:-0.04}, CVaR95:{strong:-0.03, adequate:-0.06},
    UI:{strong:0.05, adequate:0.12}, Martin:{strong:0.8, adequate:0.3}
  };

  function computeKPIFromOpt(optExecs){
    if(!optExecs.length) return null;
    let equity=OPT.capital, cumPnl=0;
    const timeline=[], tradePnls=[], tradeFees=[], tradeTaxes=[];
    let grossBuy=0, grossSell=0;
    for(const e of optExecs){
      if(e.side==='BUY'){ equity -= (e.cost||0); grossBuy+=(e.buyAmount||0); }
      else{ equity += (e.sellAmount||0) - (e.fee||0) - (e.tax||0);
            if(typeof e.pnlFull==='number'){ tradePnls.push(e.pnlFull); cumPnl+=e.pnlFull; }
            tradeFees.push(e.fee||0); tradeTaxes.push(e.tax||0); grossSell+=(e.sellAmount||0); }
      timeline.push({t:e.tsMs, eq:equity});
    }
    // 日權益 → 日報酬
    const byDay=new Map(); for(const p of timeline){ const d=new Date(p.t).toISOString().slice(0,10); byDay.set(d,p.eq); }
    const days=[...byDay.keys()].sort(); const eqs=days.map(d=>byDay.get(d));
    const rets=[]; for(let i=1;i<eqs.length;i++){ const a=eqs[i-1], b=eqs[i]; if(a>0) rets.push(b/a-1); }

    const t0=new Date(days[0]).getTime(), t1=new Date(days.at(-1)).getTime();
    const years=Math.max(1/365,(t1-t0)/(365*DAY_MS));
    const totalRet=cumPnl/OPT.capital;
    const CAGR=Math.pow(1+totalRet,1/years)-1;

    const mean=rets.length? rets.reduce((a,b)=>a+b,0)/rets.length : 0;
    const sd=rets.length>1? Math.sqrt(rets.reduce((s,x)=>s+(x-mean)*(x-mean),0)/rets.length) : 0;
    const annRet=mean*252, vol=sd*Math.sqrt(252);

    const neg=rets.filter(x=>x<0), mNeg=neg.length? neg.reduce((a,b)=>a+b,0)/neg.length : 0;
    const sdNeg=neg.length>1? Math.sqrt(neg.reduce((s,x)=>s+(x-mNeg)*(x-mNeg),0)/neg.length) : 0;
    const downside=sdNeg*Math.sqrt(252);

    const sharpe=vol>0? (annRet-CFG.rf)/vol : 0;
    const sortino=downside>0? (annRet-CFG.rf)/downside : 0;

    // Drawdown / Recovery
    let peak=eqs[0], maxDD=0, curU=0, maxU=0, recDays=0, inDraw=false, troughIdx=0, peakIdx=0, recFound=false;
    const ddSeries=[];
    for(let i=0;i<eqs.length;i++){
      const v=eqs[i]; if(v>peak){ peak=v; if(inDraw) inDraw=false; }
      const dd=(v-peak)/peak; ddSeries.push(dd);
      if(dd<maxDD){ maxDD=dd; inDraw=true; troughIdx=i; peakIdx=eqs.findIndex((x,ix)=>ix<=i && x===peak); }
      if(inDraw){ curU++; maxU=Math.max(maxU,curU); } else curU=0;
    }
    if(peakIdx<troughIdx){
      const pre=eqs[peakIdx]; for(let i=troughIdx;i<eqs.length;i++){ if(eqs[i]>=pre){ recDays=i-troughIdx; recFound=true; break; } }
      if(!recFound) recDays=Math.max(0,eqs.length-1-troughIdx);
    }
    const ddNeg=ddSeries.filter(x=>x<0);
    const UI=Math.sqrt(ddNeg.reduce((s,x)=>s+x*x,0)/Math.max(1,ddNeg.length));
    const Martin=UI>0? (annRet/UI) : 0;

    const wins=tradePnls.filter(x=>x>0), losses=tradePnls.filter(x=>x<0);
    const PF=(wins.reduce((a,b)=>a+b,0))/(Math.abs(losses.reduce((a,b)=>a+b,0))||1);
    const hit=tradePnls.length? wins.length/tradePnls.length : 0;
    const expectancy=tradePnls.length? tradePnls.reduce((a,b)=>a+b,0)/tradePnls.length : 0;
    const payoff=(wins.length? wins.reduce((a,b)=>a+b,0)/wins.length : 0) / (Math.abs(losses.length? losses.reduce((a,b)=>a+b,0)/losses.length : 1));

    const sorted=[...rets].sort((a,b)=>a-b), idx=Math.max(0, Math.floor(0.05*(sorted.length-1)));
    const VaR95 = sorted[idx] || 0;
    const tail=sorted.slice(0,idx+1); const CVaR95 = tail.length? tail.reduce((a,b)=>a+b,0)/tail.length : 0;

    const posSum=rets.filter(x=>x>0).reduce((a,b)=>a+b,0);
    const negAbs=Math.abs(rets.filter(x=>x<0).reduce((a,b)=>a+b,0));
    const GainPain = negAbs>0? (posSum/negAbs) : 9.99;
    const Omega = (rets.filter(x=>x>0).length) / Math.max(1, rets.filter(x=>x<0).length);

    const totalFees=tradeFees.reduce((a,b)=>a+b,0), totalTaxes=tradeTaxes.reduce((a,b)=>a+b,0);
    const totalCost=totalFees+totalTaxes;
    const turnover=(grossBuy+grossSell)/OPT.capital;
    const avgTradeValue=(grossBuy+grossSell)/Math.max(1,(wins.length+losses.length));
    const costRatio=(grossBuy+grossSell)>0? totalCost/(grossBuy+grossSell) : 0;

    const calmar = maxDD<0? CAGR/Math.abs(maxDD) : 0;
    const rtVol  = vol>0? annRet/vol : 0;

    return {
      period:{start:days[0], end:days.at(-1), years},
      equity:{days, series:eqs, ddSeries},
      returns:{daily:rets, annRet, vol, downside, VaR95, CVaR95, GainPain, Omega},
      pnl:{trades:tradePnls, wins, losses, total:tradePnls.reduce((a,b)=>a+b,0), maxWin:Math.max(...tradePnls,0), maxLoss:Math.min(...tradePnls,0)},
      risk:{maxDD, TU_days:maxU, Rec_days:recDays, MCL:0, UI, Martin},
      ratios:{CAGR, sharpe, sortino, calmar, rtVol, PF, hit, expectancy, payoff, totalRet},
      cost:{totalFees,totalTaxes,totalCost,grossBuy,grossSell,turnover,avgTradeValue,costRatio}
    };
  }

  // ========= KPI 渲染 =========
  function fillRows(tbodySel, rows){
    const tb=$(tbodySel); tb.innerHTML='';
    for(const r of rows){
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]?rateHtml(r[3]):'—'}</td><td class="subtle">${r[4]||'—'}</td>`;
      tb.appendChild(tr);
    }
  }
  function gatherRatings(rows){ const a=[]; for(const r of rows){ if(r[3]) a.push({name:r[0], value:r[1], desc:r[2], rating:r[3], band:r[4]}); } return a; }
  function pickSuggestions(groups){ const bag=[]; groups.forEach(g=>bag.push(...gatherRatings(g))); const bad=bag.filter(x=>x.rating!=='Strong'); bad.sort((a,b)=> (a.rating==='Improve'?0:(a.rating==='Adequate'?1:2)) - (b.rating==='Improve'?0:(b.rating==='Adequate'?1:2))); return bad.map(x=>[x.name,x.value,'—',x.rating,x.band]); }
  function renderKPI(K){
    $('#kpiOptCard').style.display='';

    const ret=[
      ['總報酬 (Total Return)', fmtPct(K.ratios.totalRet), '期末/期初 - 1', (K.ratios.totalRet>0?'Strong':'Improve'), '≥0%'],
      ['CAGR 年化', fmtPct(K.ratios.CAGR), '長期年化', (K.ratios.CAGR>=BANDS.CAGR.strong?'Strong':(K.ratios.CAGR>=BANDS.CAGR.adequate?'Adequate':'Improve')), '≥15% / ≥5%'],
      ['Arithmetic 年化', fmtPct(K.returns.annRet), '日均×252', (K.returns.annRet>=0.20?'Strong':(K.returns.annRet>=0.05?'Adequate':'Improve')), '≥20% / ≥5%'],
      ['平均每筆淨損益', fmtInt(K.ratios.expectancy), '交易損益均值', (K.ratios.expectancy>0?'Strong':'Improve'), '> 0'],
      ['勝率 (Hit Ratio)', fmtPct(K.ratios.hit), '獲利筆數/總筆數', (K.ratios.hit>=BANDS.Hit.strong?'Strong':(K.ratios.hit>=BANDS.Hit.adequate?'Adequate':'Improve')), '≥55% / ≥45%'],
      ['累積淨利 (NTD)', fmtInt(K.pnl.total), '所有賣出筆加總', (K.pnl.total>0?'Strong':'Improve'), '> 0'],
      ['單筆最大獲利/虧損', `${fmtInt(K.pnl.maxWin)} / ${fmtInt(K.pnl.maxLoss)}`, '極值', 'Adequate','—']
    ]; fillRows('#kpiOptReturn tbody', ret);

    const risk=[
      ['最大回撤 (MaxDD)', fmtPct(K.risk.maxDD), '峰值到谷底', (K.risk.maxDD<=BANDS.MaxDD.strong?'Strong':(K.risk.maxDD<=BANDS.MaxDD.adequate?'Adequate':'Improve')), '≥-10% / ≥-25%'],
      ['水下時間 (TU)', K.risk.TU_days+' 天', '在水下的最長天數', (K.risk.TU_days<=BANDS.TU_days.strong?'Strong':(K.risk.TU_days<=BANDS.TU_days.adequate?'Adequate':'Improve')), '≤45 / ≤120'],
      ['回本時間 (Recovery)', K.risk.Rec_days+' 天', '回到新高所需天數', (K.risk.Rec_days<=BANDS.Rec_days.strong?'Strong':(K.risk.Rec_days<=BANDS.Rec_days.adequate?'Adequate':'Improve')), '≤45 / ≤90'],
      ['波動率 (Volatility)', fmtPct(K.returns.vol), '年化標準差', (K.returns.vol<=BANDS.Vol.strong?'Strong':(K.returns.vol<=BANDS.Vol.adequate?'Adequate':'Improve')), '≤20% / ≤35%'],
      ['下行波動 (Downside)', fmtPct(K.returns.downside), '下行波動(年化)', (K.returns.downside<=0.15?'Strong':(K.returns.downside<=0.30?'Adequate':'Improve')), '≤15% / ≤30%'],
      ['Ulcer Index (UI)', fmtPct(K.risk.UI), '回撤平方均根', (K.risk.UI<=BANDS.UI.strong?'Strong':(K.risk.UI<=BANDS.UI.adequate?'Adequate':'Improve')), '≤5% / ≤12%'],
      ['Martin Ratio', (K.risk.Martin).toFixed(2), '年化報酬/UI', (K.risk.Martin>=BANDS.Martin.strong?'Strong':(K.risk.Martin>=BANDS.Martin.adequate?'Adequate':'Improve')), '≥0.8 / ≥0.3'],
      ['VaR 95% (1日)', fmtPct(K.returns.VaR95), '95%一日風險', (K.returns.VaR95>=-0.02?'Strong':(K.returns.VaR95>=-0.04?'Adequate':'Improve')), '>-2% / >-4%'],
      ['CVaR 95% (1日)', fmtPct(K.returns.CVaR95), '超過VaR的平均虧損', (K.returns.CVaR95>=-0.03?'Strong':(K.returns.CVaR95>=-0.06?'Adequate':'Improve')), '>-3% / >-6%']
    ]; fillRows('#kpiOptRisk tbody', risk);

    const eff=[
      ['Sharpe', (K.ratios.sharpe).toFixed(2), '風險調整報酬', (K.ratios.sharpe>=BANDS.Sharpe.strong?'Strong':(K.ratios.sharpe>=BANDS.Sharpe.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.5'],
      ['Sortino', (K.ratios.sortino).toFixed(2), '下行風險報酬', (K.ratios.sortino>=BANDS.Sortino.strong?'Strong':(K.ratios.sortino>=BANDS.Sortino.adequate?'Adequate':'Improve')), '≥1.5 / ≥0.75'],
      ['Calmar', (K.ratios.calmar).toFixed(2), 'CAGR / |MaxDD|', (K.ratios.calmar>=BANDS.Calmar.strong?'Strong':(K.ratios.calmar>=BANDS.Calmar.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.3'],
      ['Reward/Vol', (K.ratios.rtVol).toFixed(2), '年化報酬/波動', (K.ratios.rtVol>=BANDS.RtVol.strong?'Strong':(K.ratios.rtVol>=BANDS.RtVol.adequate?'Adequate':'Improve')), '≥1.0 / ≥0.5'],
      ['Profit Factor (PF)', (K.ratios.PF).toFixed(2), '總獲利/總虧損', (K.ratios.PF>=BANDS.PF.strong?'Strong':(K.ratios.PF>=BANDS.PF.adequate?'Adequate':'Improve')), '≥1.5 / ≥1.0'],
      ['Payoff Ratio', (K.ratios.payoff).toFixed(2), '均獲利/均虧損', (K.ratios.payoff>=BANDS.Payoff.strong?'Strong':(K.ratios.payoff>=BANDS.Payoff.adequate?'Adequate':'Improve')), '≥1.5 / ≥1.0']
    ]; fillRows('#kpiOptEff tbody', eff);

    const stab=[ ['偏態 (Skewness)','—','分配偏度(>0偏右尾)','Adequate','> 0'], ['峰度 (Kurtosis)','—','分配峰度(≈3常態；>10尾風險高)','Adequate','≤10'] ];
    fillRows('#kpiOptStab tbody', stab);

    const cost=[
      ['總費用(手續費+稅)', fmtInt(K.cost.totalFees + K.cost.totalTaxes), '所有賣出筆累計', 'Adequate', '—'],
      ['費用比 (Cost Ratio)', fmtPct(K.cost.costRatio), '(費用/成交額)', (K.cost.costRatio<=BANDS.CostRatio.strong?'Strong':(K.cost.costRatio<=BANDS.CostRatio.adequate?'Adequate':'Improve')), '<0.10% / <0.30%'],
      ['成交額週轉率 (Turnover)', (K.cost.turnover).toFixed(2)+'x', '成交額/本金', (K.cost.turnover<=BANDS.Turnover.strong?'Strong':(K.cost.turnover<=BANDS.Turnover.adequate?'Adequate':'Improve')), '1~2x'],
      ['筆均成交額 (Avg Trade Value)', fmtInt(K.cost.avgTradeValue), '成交額/筆數', (K.cost.avgTradeValue>=100000?'Strong':(K.cost.avgTradeValue>=30000?'Adequate':'Improve')), '≥100k / ≥30k'],
      ['買入總額 / 賣出總額', `${fmtInt(K.cost.grossBuy)} / ${fmtInt(K.cost.grossSell)}`, '流動性利用', 'Adequate','—'],
      ['Omega(0%)', (K.returns.Omega).toFixed(2), 'P(R>0)/P(R<0)', (K.returns.Omega>=1.5?'Strong':(K.returns.Omega>=1.0?'Adequate':'Improve')), '≥1.5 / ≥1.0'],
      ['MAR (CAGR/MaxDD)', (K.ratios.calmar).toFixed(2), '等同 Calmar', (K.ratios.calmar>=1?'Strong':(K.ratios.calmar>=0.3?'Adequate':'Improve')), '≥1.0 / ≥0.3']
    ]; fillRows('#kpiOptCost tbody', cost);

    const sugg=pickSuggestions([ret,risk,eff,stab,cost]);
    fillRows('#kpiOptSuggest tbody', sugg);

    // 基準卡片（呼叫外部函數填入）
    renderBenchmarkCard(K.period.days, K.returns.daily);
  }

  // ========= 基準（Alpha/Beta/IR/TE/R²/捕捉/Treynor） =========
  async function loadBenchmark(days){
    const u=new URL(location.href);
    const tag=(u.searchParams.get('benchmark')||'').toUpperCase();
    const benchFile=u.searchParams.get('benchfile');
    const benchUrl =u.searchParams.get('benchurl');
    let src=null;
    if(benchUrl) src=benchUrl;
    else if(benchFile) src=pubUrl(benchFile);
    else if(tag==='0050') src=pubUrl('benchmarks/0050_daily.csv');
    else if(tag==='TWII') src=pubUrl('benchmarks/TWII_daily.csv');
    if(!src) return {ok:false, reason:'未連結基準（?benchmark=0050/TWII 或 ?benchfile= / ?benchurl=）'};
    try{
      const txt=await fetchText(src);
      const lines=txt.replace(/\r\n?/g,'\n').split('\n').filter(Boolean);
      if(lines.length<2) return {ok:false, reason:'基準檔無資料行'};
      const head=lines[0].toLowerCase(); const data=[];
      if(head.includes('ret')){ for(let i=1;i<lines.length;i++){ const [d,r]=lines[i].split(/[, \t]+/); if(d && !isNaN(+r)) data.push({d:d.slice(0,10), r:+r}); } }
      else{ let prev=null; for(let i=1;i<lines.length;i++){ const [d,c]=lines[i].split(/[, \t]+/); const px=+c; if(d && px>0){ if(prev!=null) data.push({d:d.slice(0,10), r:px/prev-1}); prev=px; } } }
      const map=new Map(data.map(x=>[x.d,x.r])); const br=[]; for(const d of days){ if(map.has(d)) br.push(map.get(d)); }
      if(br.length<5) return {ok:false, reason:'對齊後可用日數 < 5'};
      return {ok:true, rets:br};
    }catch(e){ return {ok:false, reason:'下載或解析失敗'}; }
  }
  function regressXY(x,y){
    const n=x.length; if(n<2) return {alpha:0,beta:0,r2:0};
    const mx=x.reduce((a,b)=>a+b,0)/n, my=y.reduce((a,b)=>a+b,0)/n;
    let sxx=0,syy=0,sxy=0; for(let i=0;i<n;i++){ const dx=x[i]-mx, dy=y[i]-my; sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy; }
    const beta=sxx>0? sxy/sxx : 0; const alpha=my-beta*mx; const r2=(sxx>0&&syy>0)? (sxy*sxy)/(sxx*syy) : 0;
    return {alpha,beta,r2};
  }
  function benchKPIs(stratRets, benchRets, rf=0){
    const n=Math.min(stratRets.length, benchRets.length);
    if(n<5) return null;
    const s=stratRets.slice(-n), b=benchRets.slice(-n);
    const active=s.map((v,i)=> v-b[i]); const meanA=active.reduce((a,c)=>a+c,0)/n;
    const sdA=Math.sqrt(active.reduce((a,c)=>a+(c-meanA)*(c-meanA),0)/Math.max(1,n));
    const TE=sdA*Math.sqrt(252); const IR=TE>0? (meanA*252)/TE : 0;
    const {alpha,beta,r2}=regressXY(b,s); const alphaAnn=alpha*252;
    const treynor = beta!==0? ((s.reduce((a,c)=>a+c,0)/n)*252 - rf)/beta : 0;
    // capture
    const upIdx=b.map((v,i)=>[v,i]).filter(p=>p[0]>0).map(p=>p[1]);
    const dnIdx=b.map((v,i)=>[v,i]).filter(p=>p[0]<0).map(p=>p[1]);
    const avg=a=>a.length? a.reduce((x,y)=>x+y,0)/a.length : 0;
    const upCap = upIdx.length? (avg(upIdx.map(i=>s[i]))/Math.max(1e-9, avg(upIdx.map(i=>b[i])))) : null;
    const dnCap = dnIdx.length? (avg(dnIdx.map(i=>s[i]))/Math.max(1e-9, avg(dnIdx.map(i=>b[i])))) : null;
    return {IR,TE,beta,r2,alphaAnn,treynor,upCap,dnCap};
  }
  function renderBenchmarkCard(days, stratDailyRets){
    const tbody=$('#kpiOptBench tbody'); tbody.innerHTML='';
    loadBenchmark(days).then(info=>{
      if(!info.ok){ const tr=document.createElement('tr'); tr.innerHTML=`<td colspan="4">— ${info.reason}</td>`; tbody.appendChild(tr); return; }
      const KP=benchKPIs(stratDailyRets, info.rets, CFG.rf); if(!KP){ const tr=document.createElement('tr'); tr.innerHTML=`<td colspan="4">— 基準樣本不足</td>`; tbody.appendChild(tr); return; }
      const rows=[
        ['Alpha (年化 Jensen)', (KP.alphaAnn*100).toFixed(2)+'%', '回歸截距 × 252', '—'],
        ['Beta', KP.beta.toFixed(3), '對市場敏感度', '—'],
        ['Information Ratio (IR)', KP.IR.toFixed(2), '年化超額 / 追蹤誤差', '—'],
        ['Tracking Error (TE)', (KP.TE*100).toFixed(2)+'%', '超額報酬標準差年化', '—'],
        ['R²', KP.r2.toFixed(3), '回歸擬合度', '—'],
        ['Upside Capture', KP.upCap==null?'—':KP.upCap.toFixed(2), '基準上漲日：策略/基準', '—'],
        ['Downside Capture', KP.dnCap==null?'—':KP.dnCap.toFixed(2), '基準下跌日：策略/基準', '—'],
        ['Treynor Ratio', KP.treynor.toFixed(2), '(年化超額)/Beta', '—'],
      ];
      for(const r of rows){ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td>`; tbody.appendChild(tr); }
    }).catch(()=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td colspan="4">— 基準載入失敗</td>`; tbody.appendChild(tr); });
  }

  // ========= 明細表（以 optExecs） =========
  function renderOptTable(optExecs){
    const thead=$('#optTable thead'), tbody=$('#optTable tbody');
    thead.innerHTML=`<tr>
      <th>種類</th><th>日期</th><th>成交價格</th><th>成本均價</th><th>成交數量</th>
      <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
      <th>成本</th><th>累計成本</th><th>損益</th><th>報酬率</th><th>累計損益</th>
    </tr>`;
    tbody.innerHTML='';
    for(const e of optExecs){
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

  // ========= 主流程 =========
  async function boot(){
    try{
      set('從 Supabase 讀取清單…');
      const u=new URL(location.href); const paramFile=u.searchParams.get('file');

      let latest=null, list=[];
      if(paramFile){ latest={ name:paramFile.split('/').pop()||'00909.txt', fullPath:paramFile, from:'url' }; }
      else{
        list=(await listCandidates()).filter(f=>CFG.want.test(f.name)||CFG.want.test(f.fullPath));
        list.sort((a,b)=>{ const sa=lastDateScore(a.name), sb=lastDateScore(b.name); if(sa!==sb) return sb-sa; if(a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt; return (b.size||0)-(a.size||0); });
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

      const start8=rows[0].day, end8=rows.at(-1).day;
      $('#periodText').textContent=`期間：${start8} 開始到 ${end8} 結束`;

      // 原始 → 最佳化
      const bt = backtest(rows);
      const optExecs = buildOptimizedExecs(bt.execs);

      // 目前持有（若有）
      renderCurrentPosition(optExecs);

      // 週圖 / 明細（opt）
      renderWeeklyChartFromOpt(optExecs);
      renderOptTable(optExecs);

      // KPI（opt）
      const K = computeKPIFromOpt(optExecs);
      if(K) renderKPI(K);

      // 基準（若 query 有設參數，會讀檔計算；否則顯示提示）
      renderBenchmarkCard(K.period.days, K.returns.daily);

      const btn=$('#btnSetBaseline'); if(btn) btn.disabled=true;
      set('完成。');
    }catch(err){
      console.error('[00909 ERROR]', err);
      set('初始化失敗：'+(err?.message||String(err)), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
