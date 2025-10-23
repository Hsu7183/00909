// etf-00909.js — 00909 專用：optExecs 為唯一績效口徑 + 週次條形&累積線 + 全套 KPI + 基準 + 目前持有(多筆)
// 版本：kpi-opt-v9.2  (修復語法、強化基準讀取 & 目前持有多筆換行、全量功能保留)
(function () {
  'use strict';

  /* ========== 小工具 ========== */
  function $(sel) { return document.querySelector(sel); }
  function fmtInt(x) { return Number.isFinite(x) ? Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '—'; }
  function fmtPct(v) { return (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(2) + '%'; }
  function tsPretty(ts14) { return ts14 ? (ts14.slice(0,4)+'/'+ts14.slice(4,6)+'/'+ts14.slice(6,8)+' '+ts14.slice(8,10)+':'+ts14.slice(10,12)) : '—'; }
  function setStatus(msg, isErr){ const el = document.getElementById('message'); const s = document.getElementById('autostatus'); const t = s||el; if (t){ t.textContent = msg; t.style.color = isErr ? '#c62828':'#666'; } }
  function rateHtml(tag){ var m = (tag==='Strong'?'(強)':(tag==='Adequate'?'(可)':'(瘦)')); var cls = (tag==='Strong'?'rate-strong':(tag==='Adequate'?'rate-adequate':'rate-improve')); return '<span class="'+cls+'">'+tag+' '+m+'</span>'; }
  var DAY_MS = 24*60*60*1000;

  /* ========== 設定 ========== */
  var CFG = {
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
  var OPT = { capital: 1_000_000, unitShares: CFG.unitShares, ratio: [1,1,2] };

  // 填入 chips
  var fr = document.getElementById('feeRateChip'); if (fr) fr.textContent = (CFG.feeRate*100).toFixed(4)+'%';
  var tr = document.getElementById('taxRateChip'); if (tr) tr.textContent = (CFG.taxRate*100).toFixed(3)+'%';
  var mf = document.getElementById('minFeeChip'); if (mf) mf.textContent = String(CFG.minFee);
  var us = document.getElementById('unitChip'); if (us) us.textContent = String(CFG.unitShares);
  var sl = document.getElementById('slipChip'); if (sl) sl.textContent = '0';
  var rfc= document.getElementById('rfChip'); if (rfc) rfc.textContent = (CFG.rf*100).toFixed(2)+'%';

  /* ========== Supabase 工具 ========== */
  var SUPABASE_URL="https://byhbmmnacezzgkwfkozs.supabase.co";
  var SUPABASE_KEY="sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { global:{ fetch: function(u,o){ return fetch(u, Object.assign({cache:'no-store'}, o||{})); } }});
  function pubUrl(path){ var got = sb.storage.from(CFG.bucket).getPublicUrl(path); return (got && got.data) ? got.data.publicUrl : '#'; }
  function listOnce(prefix){
    var p = (prefix && !/\/$/.test(prefix)) ? (prefix + '/') : (prefix||'');
    return sb.storage.from(CFG.bucket).list(p, { limit:1000, sortBy:{ column:'name', order:'asc'} })
      .then(function(res){ if(res.error) throw res.error; return (res.data||[]).map(function(d){ return { name:d.name, fullPath: p + d.name, updatedAt: d.updated_at ? Date.parse(d.saved_at||d.updated_at) : 0 };}); });
  }
  function listCandidates(){
    var u = new URL(location.href);
    var p = u.searchParams.get('prefix') || '';
    return listOnce(p);
  }
  function fetchText(url){
    return fetch(url, { cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error(r.status+' '+r.statusText);
      return r.arrayBuffer();
    }).then(function(buf){
      var encs=['utf-8','utf-16le','utf-16be','utf-32le','utf-32be','big5','windows-1252'];
      for (var i=0;i<encs.length;i++){
        try { return new TextDecoder(encs[i]).decode(buf).replace(/\ufeff/g,''); }
        catch(e){}
      }
      return new TextDecoder().decode(buf);
    });
  }

  /* ========== 依 base rows 產生最佳化 optExecs（多筆 BUY + 一筆 SELL；保留未平倉 BUY） ========== */
  function splitSegments(execs){
    var segs=[], cur=[];
    for (var i=0;i<execs.length;i++){
      var e = execs[i];
      cur.push(e);
      if (e.side==='SELL'){ segs.push(cur); cur=[]; }
    }
    if (cur.length) segs.push(cur);
    return segs;
  }
  function feePack(px, qty, isSell){
    var gross = px * qty;
    var fee   = Math.max(CFG.minFee, gross * CFG.feeRate);
    var tax   = isSell ? (gross * CFG.rateTax || CFG.taxRate* gross) : 0;
    return { gross:gross, fee:fee, tax:tax };
  }
  function buyCostLots(px, lots){
    var q = lots * OPT.unitShares;
    var fp = feePack(px, q, false);
    return { shares: q, gross: fp.gross, fee: fp.fee, cost: fp.gross + fp.fee };
  }
  function buildOptExecs(baseExecs){
    var segs = splitSegments(baseExecs);
    var out = [];
    var cumP = 0;

    for (var s = 0; s < segs.length; s++){
      var seg = segs[s];
      var buys = []; var sell = null;
      for (var i=0;i<seg.length;i++){
        if (seg[i].side==='BUY') buys.push(seg[i]); else { sell = seg[i]; }
      }
      if (!buys.length) continue;

      // 1-1-2 + 資金上限
      var baseCost = buyCostLots(buys[0].price, 1).cost;
      var maxLots = Math.max(0, Math.floor(OPT.capital / (baseCost||1)));
      if (maxLots === 0) continue;

      var plan = [];
      if (buys.length >= 1) plan.push(Math.max(1, Math.floor(maxLots/4)));
      if (buys.length >= 2) plan.push(Math.max(1, Math.floor(maxLots/4)));
      if (buys.length >= 3) plan.push(Math.max(1, Math.floor(maxLots/2)));

      var held=0, avg=0, accCost=0, units=0;

      // emit BUY legs
      for (var j=0; j<buys.length && j<3; j++){
        var b = buys[j];
        var pack = buyCostLots(b.price, plan[j]);
        // 確保不超資
        var maxAffordableLots = Math.floor((OPT.capital - accCost) / Math.max(1, buyCostLots(b.price,1).cost));
        var useLots = Math.max(0, Math.min(plan[j], maxAffordableLots));
        if (useLots === 0) break;
        var bp = buyCostLots(b.price, useLots);
        accCost += bp.cost;
        held += bp.shares;
        units += useLots;
        avg = (avg*( (held - bp.shares) ) + b.price * bp.shares) / (held || 1);

        out.push({
          side:'BUY', ts:b.ts, tsMs:b.tsMs, price:b.price, avgCost:avg,
          shares: bp.shares, buyAmount: bp.gross, sellAmount:0,
          fee: bp.fee, tax:0, cost: bp.cost, cumCost: accCost,
          pnlFull: null, retPctUnit: null, cumPnlFull: cumP
        });
      }

      // emit SELL if any sell exists
      if (sell && held > 0) {
        var sp = feePack(sell.price, held, true);
        var pnl = sp.gross - (accCost + sp.fee + sp.tax);
        var retU = (units>0 && accCost>0) ? (pnl / (accCost/units)) : null;
        cumP += pnl;

        out.push({
          side:'SELL', ts:sell.ts, tsMs:sell.tsMs, price:sell.price, avgCost: avg,
          shares: held, buyAmount:0, sellAmount: sp.gross, fee: sp.fee, tax: sp.tax,
          cost: 0, cumCost: accCost, pnlFull: pnl, retPctUnit: retU, cumPnlFull: cumP
        });
      }
      // 若無 SELL：只保留 BUY（未平倉），不變動 cumP
    }

    // 依時間排序
    out.sort(function(a,b){ return a.tsMs - b.tsMs; });
    return out;
  }

  /* ========== 週次圖（optExecs → SELL pnl 聚合 + 累積線） ========== */
  var weeklyChartRef=null;
  function renderWeeklyChart(optExecs){
    var box = document.getElementById('weeklyCard');
    var canvas = document.getElementById('chWeekly');
    if (!box || !canvas) return;

    var map = new Map(), order=[];
    for (var i=0;i<optExecs.length;i++){
      var e = optExecs[i];
      if (e.side !== 'SELL' || !isFinite(e.pnlFull)) continue;
      var d = new Date(e.tsMs);
      var dow = (d.getUTCDay()+6)%7;
      var w  = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-dow)).toISOString().slice(0,10);
      if (!map.has(w)) { map.set(w,0); order.push(w); }
      map.set(w, map.get(w) + e.pnlFull);
    }
    if (order.length === 0){ box.style.display='none'; return; }
    box.style.display='';

    var weekly=[], cum=[];
    for (var k=0;k<order.length;k++){
      var p = map.get(order[k]) || 0;
      weekly.push(p);
      cum.push((k===0?0:cum[k-1]) + p);
    }

    if (weeklyChartRef) { weeklyChartRef.destroy(); }
    var ymax = Math.max.apply(null, cum.concat([0])) * 1.05 || 1;

    weeklyChartRef = new Chart(canvas.getContext('2d'), {
      type:'bar',
      data: {
        labels: order,
        datasets: [
          { type:'bar',  label:'每週獲利（浮動長條）', data: cum.map(function(v,i){ return [i>0?cum[i-1]:0, v]; }), backgroundColor:'rgba(13,110,253,0.30)', borderColor:'#0d6efd', borderWidth:1 },
          { type:'line', label:'累積淨利', data: cum, borderColor:'#f43b69', borderWidth:2, tension:0.2, pointRadius:0 }
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        parsing: { yAxisKey: undefined },
        scales: { y: { suggestedMin:0, suggestedMax: ymax }, x:{ ticks:{ maxTicksLimit:12 } } },
        plugins:{ legend:{ display:true } }
      }
    });
  }

  /* ========== KPI（以 optExecs 計算） ========== */
  var BANDS = {
    CAGR:{ strong:0.15, adequate:0.05 },
    MaxDD:{ strong:-0.10, adequate:-0.25 },
    Vol  :{ strong:0.20,  adequate:0.35 },
    Down :{ strong:0.15,  adequate:0.30 },
    Sharpe:{ strong:1.0,  adequate:0.5 },
    Sortino:{strong:1.5,  adequate:0.75 },
    Calmar:{ strong:1.0,  adequate:0.3 },
    RtVol: { strong:1.0,  adequate:0.5 },
    PF    :{ strong:1.5,  adequate:1.0 },
    MCL   :{ strong:5,    adequate:10 },
    CostR :{ strong:0.10, adequate:0.30 }, // note: percent
    Omega :{ strong:1.5,  adequate:1.0 }
  };
  function computeKPIs(optExecs){
    var cap = CFG.initialCapital;
    var eq = cap, cumP=0, gb=0, gs=0, fees=0, taxes=0, tl=[], tPnls=[];
    var openShares=0, avg=0, accCost=0;

    for (var i=0;i<optExecs.length;i++){
      var e = optExecs[i];
      if (e.side==='BUY'){
        eq -= (e.cost||0);
        openShares += e.shares||0;
        accCost    += e.cost||0;
        avg = (avg*(openShares - e.shares) + e.price*(e.shares||0)) / (openShares||1);
        gb += (e.buyAmount||0);
      } else {
        var net = (e.sellAmount||0) - (e.fee||0) - (e.tax||0);
        eq += net;
        cumP += (e.pnlFull||0);
        gs += (e.sellAmount||0);
        fees += (e.fee||0);
        taxes += (e.tax||0);
        openShares = 0; acc=0; avg=0;
      }
      tl.push({ t:e.tsMs, v: eq });
      if (typeof e.pnlFull === 'number') tPnls.push(e.pnlFull);
    }

    // 日報酬 from end-of-day equity (realized P&L path)
    var dayMap = new Map(); 
    for (var k=0;k<tl.length;k++){
      var d = new Date(tl[k].date || tl[k].t);
      var ds = new Date(tl[k].t).toISOString().slice(0,10);
      dayMap.set(ds, tl[k].v);
    }
    var days = Array.from(dayMap.keys()).sort();
    var eqs  = days.map(function(d){ return dayMap.get(d); });
    var rets=[];
    for (var j=1;j<eqs.length; j++){
      var a = eqs[j-1], b = eqs[j];
      if (a>0) rets.push((b/a)-1);
    }

    // 年化、風險
    var t0 = days.length? Date.parse(days[0]) : Date.now();
    var t1 = days.length? Date.parse(days[days.length-1]) : t0;
    var years = Math.max(1/365, (t1 - t0)/ (365*24*60*60*1000));
    var totalRet = cumP / cap;
    var CAGR = Math.pow(1+totalRet, 1/years) - 1;

    var mean = rets.length? rets.reduce(function(a,b){return a+b;},0)/rets.length : 0;
    var sd = rets.length>1? Math.sqrt(rets.reduce(function(s,x){ return s + Math.pow(x-mean,2); }, 0)/rets.length) : 0;
    var annRet = mean * 252;
    var vol = sd * Math.sqrt(252);
    var negs = rets.filter(function(x){return x<0;});
    var mneg = negs.length? negs.reduce(function(a,b){return a+b;},0)/negs.length : 0;
    var sdNeg = negs.length>1? Math.sqrt(negs.reduce(function(s,x){ return s + Math.pow(x-mneg,2); },0)/negs.length) : 0;
    var down = sdNeg * Math.sqrt(252);
    var sharpe = vol>0 ? (annRet - CFG.rf)/vol : 0;
    var sortino= down>0? (annRet - CFG.rf)/down : 0;

    var maxDD = (function(arr){
      if(!arr.length) return 0;
      var peak = arr[0], minRel = 0, cur=0, maxU=0, rec=0, trough=0;
      for (var i=0;i<arr.length;i++){
        if (arr[i] > peak) peak = arr[i];
        var rel = (arr[i]-peak) / peak;
        if (rel < minRel) { minRel = rel; }
        if (rel < 0) { cur++; maxU = Math.max(maxU, cur); }
        else { cur = 0; }
      }
      return minRel;
    })(eqs);

    var tuRec = (function(arr){
      if(!arr.length) return {TU:0, Rec:0};
      var peak = arr[0], draw=0, maxU=0, rec=0, trough=-1, lastPeak=arr[0];
      for (var i=0;i<arr.length;i++){
        if (arr[i] > peak) { peak=arr[i]; }
        if (arr[i] < peak) { draw++; } else { if (draw>max=draw) max=draw; draw=0; }
      }
      // compute recovery length from deepest drawdown
      var minVal = Math.min.apply(null, arr);
      var minIdx = arr.indexOf(minVal);
      var base = 0;
      for (var m=minIdx; m>=0; m--){ if (arr[m] >= arr[minIdx]) { base = arr[m]; break; } }
      var r=0; for (var n=minIdx; n<arr.length; n++){ if (arr[n] >= base){ break; } r++; }
      return {TU:maxU, Rec:r};
    })(eqs);

    // Ulcer index
    var ulcer = (function(arr){
      if(!arr.length) return 0;
      var u = [];
      var peak = arr[0];
      for (var i=0;i<arr.length;i++){
        if (arr[i] > peak) peak = arr[i];
        var dd = (arr[i]-peak)/peak;
        if (dd<0) u.push(dd*dd);
      }
      if (!u.length) return 0;
      var mean2 = u.reduce(function(a,b){return a+b;},0) / u.length;
      return Math.sqrt(mean2);
    })(eqs);

    // PF / Payoff / MCL
    var wins = tPnls.filter(function(x){ return x>0;});
    var loss = tPnls.filter(function(x){ return x<0;});
    var pf   = (function(winArr, lossArr){
      var w = winArr.reduce(function(a,b){return a+b;},0);
      var l = Math.abs(lossArr.reduce(function(a,b){return a+b;},0));
      return (l>0) ? (w/l) : (w>0?99:0);
    })(wins,loss);
    var payoff = (function(ws,ls){
      var wavg = ws.length? ws.reduce(function(a,b){return a+b;},0)/ws.length : 0;
      var lavg = ls.length? Math.abs(ls.reduce(function(a,b){return a+b;},0))/ls.length : 0;
      return (lavg>0)? (wavg/lavg) : (wavg>0?99:0);
    })(wins,loss);
    var mcl = (function(arr){
      var m=0,c=0; for (var i=0;i<arr.length;i++){ if(arr[i]<0){c++; if(c>m)m=c;} else c=0; } return m;
    })(tPnls);

    var totalFees = fees; var totalTaxes = taxes;
    var totalCost = totalFees + totalTaxes;
    var turnover  = (gb + gs) / cap;
    var avgTradeValue = (gb + gs) / Math.max(1, tPnls.length);
    var omega = (function(arr){ var p=arr.filter(function(x){return x>0;}).length; var q=arr.filter(function(x){return x<0;}).length; return q? (p/q) : (p?99:0); }) (rets);

    return {
      period : { days: days, start: days[0]||'', end: days.length?days[days.length-1]:'', years: years },
      returns: { daily: rets, annRet:annRet, vol:vol, downside:down, VaR95: var95(rets), CVaR95: cvar95(rets), Omega: omega },
      pnl    : { trades: tPnls, total: cumP, maxWin: Math.max.apply(null, tPnls.concat([0])), maxLoss: Math.min.apply(null, tPnls.concat([0])) },
      risk   : { maxDD:maxDD, TU_days: tuRec.TU, Rec_days: tuRec.Rec, UI:ulcer, Martin: (ulcer>0? annRet/ulcer : 0), MCL: mcl },
      ratios : { totalRet: totalRet, CAGR: CAGR, sharpe:sharpe, sortino:sortino, calcar: (Math.abs(maxDD)>0? CAGR/Math.abs(maxDD):0), rtVol: (vol>0? (annRet/vol):0), PF:pf, hit: (tPnls.length? (wins.length/tPnls.length):0), payoff: payoff },
      cost   : { totalFees: totalFees, totalTaxes: totalTaxes, totalCost: totalCost, grossBuy: gb, grossSell: gs, turnover: turnover, avgTradeValue: avgTradeValue, costRatio: (gb+gs>0? totalCost/(gb+gs): 0) }
    };

    function var95(a){ if(!a.length) return null; var s=[].concat(a).sort(function(x,y){return x-y;}); var i=Math.max(0, Math.floor(0.05*(s.length-1))); return s[i]; }
    function cvar95(a){ var s=[].concat(a).sort(function(x,y){return x-y;}); var k=Math.max(0, Math.floor(0.05*(s.length-1))); var t=s.slice(0,k+1); return t.length? t.reduce(function(p,c){return p+c;},0)/t.length : null; }
  }

  function renderKPI(K){
    var blk = document.getElementById('kpiOptCard'); if(blk) blk.style.display='';
    function addRows(tid, rows){
      var tb=document.querySelector(tid+' tbody'); if(!tb) return;
      tb.innerHTML=''; 
      for(var i=0;i<rows.length;i++){
        var r=rows[i];
        var tr=document.createElement('tr');
        tr.innerHTML='<td>'+r.name+'</td><td>'+r.val+'</td><td>'+r.desc+'</td><td>'+rateHtml(r.tag)+'</td><td class="subtle">'+(r.band||'—')+'</td>';
        tb.appendChild(tr);
      }
    }
    function tagGE(v, band){ if(v==null) return '—'; return (v>=band.strong?'Strong':(v>=band.heat? 'Adequate':'Improve')); }
    function tagLE(v, band){ if(v==null) return '—'; return (v<=band.strong?'Strong':(v<=band.adequate? 'Adequate':'Improve')); }

    var ret = [
      {name:'總報酬 (Total Return)', val: fmtInt(K.pnl.total)+' ('+fmtPct(K.ratios.totalRet)+')', desc:'期末/期初 - 1', tag:(K.ratios.totalRet>0?'Strong':'Improve'), band:'≥0%'},
      {name:'CAGR 年化',  val: fmtPct(K.ratios.CAGR),  desc:'長期年化', tag:(K.ratios.CAGR>=0.15?'Strong':(K.ratios.CAGR>=0.05?'Adequate':'Improve')), band:'≥15% / ≥5%'},
      {name:'Arithmetic 年化', val: fmtPct(K.returns.ann), desc:'日均×252', tag:(K.returns.ann>=0.20?'Strong':(K.returns.ann>=0.05?'Adequate':'Improve')), band:'≥20% / ≥5%'},
      {name:'平均每筆淨利', val: fmtInt(K.pnl.trades.length? K.pnl.total/K.pnl.trades.length:0), desc:'交易損益均值', tag:(K.pnl.trades.length && K.pnl.total/K.pnl.trades.length>0?'Strong':'Improve'), band:'> 0'},
      {name:'勝率 (Hit Ratio)', val: fmtPct(K.ratios.hit), desc:'獲利筆數/總筆數', tag:(K.ratios.hit>=0.55?'Strong':(K.ratios.hit>=0.45?'Adequate':'Improve')), band:'≥55% / ≥45%'},
      {name:'單筆最大獲利/虧損', val: fmtInt(K.pnl.maxWin)+' / '+fmtInt(K.pnl.maxLoss), desc:'極值', tag:'Adequate', band:'—'}
    ];
    addRows('#kpiOptReturn', ret);

    var risk = [
      {name:'最大回撤 (MaxDD)', val: fmtPct(K.risk.maxDD), desc:'峰值到谷底', tag:(K.risk.maxDD<=-0.10?'Strong':(K.risk.maxDD<=-0.25?'Adequate':'Improve')), band:'≥-10% / ≥-25%'},
      {name:'水下時間 (TU)', val: (K.risk.TU_days)+' 天', desc:'在水下的最長天數', tag:(K.risk.TU_days<=45?'Strong':(K.risk.TU_days<=120?'Adequate':'Improve')), band:'≤45 / ≤120'},
      {name:'回本時間 (Recovery)', val:(K.risk.Rec_days)+' 天', desc:'回到新高所需天數', tag:(K.risk.Rec_days<=45?'Strong':(K.risk.Rec_days<=90?'Adequate':'Improve')), band:'≤45 / ≤90'},
      {name:'波動率 (Volatility)', val: fmtPct(K.returns.vol), desc:'年化標準差', tag:(K.returns.vol<=0.20?'Strong':(K.returns.vol<=0.35?'Adequate':'Improve')), band:'≤20% / ≤35%'},
      {name:'下行波動 (Downside Dev)', val: fmtPct(K.returns.down), desc:'只計下行波動', tag:(K.returns.down<=0.15?'Strong':(K.returns.down<=0.30?'Adequate':'Improve')), band:'≤15% / ≤30%'},
      {name:'Ulcer Index (UI)', val: fmtPct(K.risk.UI), desc:'回撤平方均根', tag:(K.risk.UI<=0.05?'Strong':(K.risk.UI<=0.12?'Adequate':'Improve')), band:'≤5% / ≤12%'},
      {name:'Martin Ratio', val:(K.risk.Martin).toFixed(2), desc:'年化報酬/UI', tag:(K.risk.Martin>=0.8?'Strong':(K.risk.Martin>=0.3?'Adequate':'Improve')), band:'≥0.8 / ≥0.3'},
      {name:'VaR 95% (1日)', val: fmtPct(K.returns.VaR95), desc:'95%一日風險', tag:(K.returns.VaR95>=-0.02?'Strong':(K.returns.VaR95>=-0.04?'Adequate':'Improve')), band:'>-2% / >-4%'},
      {name:'CVaR 95% (1日)', val: fmtPct(K.returns.CVaR95), desc:'超過VaR平均虧損', tag:(K.returns.CVaR95>=-0.03?'Strong':(K.returns.CVaR95>=-0.06?'Adequate':'Improve')), band:'>-3% / >-6%'}
    ];
    addRows('#kpiOptRisk', risk);

    var eff = [
      {name:'Sharpe', val:(K.ratios.sharpe).toFixed(2), desc:'風險調整報酬', tag:(K.ratios.sharpe>=1?'Strong':(K.ratios.sharpe>=0.5?'Adequate':'Improve')), band:'≥1.0 / ≥0.5'},
      {name:'Sortino', val:(K.ratios.sortino).toFixed(2), desc:'下行風險調整', tag:(K.ratios.sortino>=1.5?'Strong':(K.ratios.sortino>=0.75?'Adequate':'Improve')), band:'≥1.5 / ≥0.75'},
      {name:'Calmar',  val:(Math.abs(K.risk.maxDD)>0? (K.ratios.CAGR/Math.abs(K.risk.maxDD)):0).toFixed(2), desc:'CAGR / |MaxDD|', tag:(Math.abs(K.risk.maxDD)>0 && (K.ratios.CAGR/Math.abs(K.risk.maxDD))>=1?'Strong':((Math.abs(K.risk.maxDD)>0 && (K.ratios.CAGR/Math.abs(K.risk.maxDD))>=0.3)?'Adequate':'Improve')), band:'≥1.0 / ≥0.3'},
      {name:'Reward/Vol', val:(K.ratios.rtVol).toFixed(2), desc:'年化報酬/波動', tag:(K.ratios.rtVol>=1?'Strong':(K.ratios.rtVol>=0.5?'Adequate':'Improve')), band:'≥1.0 / ≥0.5'},
      {name:'PF (Profit Factor)', val:(K.ratios.PF).toFixed(2), desc:'總利潤/總虧損', tag:(K.ratios.PF>=1.5?'Strong':(K.ratios.PF>=1?'Adequate':'Improve')), band:'≥1.5 / ≥1.0'},
      {name:'Payoff', val:(K.ratios.payoff).toFixed(2), desc:'均利潤/均虧損', tag:(K.ratios.payoff>=1.5?'Strong':(K.ratios.payoff>=1 ?'Adequate':'Improve')), band:'≥1.5 / ≥1.0'},
      {name:'最大連敗 (MCL)', val:K.risk.MCL, desc:'最大連續虧損次數', tag:(K.risk.MCL<=5?'Strong':(K.risk.MCL<=10?'Adequate':'Improve')), band:'≤5 / ≤10'}
    ];
    addRows('#kpiOptEff', eff);

    var stab = [
      {name:'偏態 (Skewness)', val:'—', desc:'分配偏度(>0偏右尾)', tag:'Adequate', band:'> 0'},
      {name:'峰度 (Kurtosis)', val:'—', desc:'分配峰度(≈3常態;>10重尾)', tag:'Adequate', band:'≤10'}
    ];
    addRows('#kpiOptStab', stab);

    var cost = [
      {name:'總費用(手續費+稅)', val:fmtInt(K.cost.totalCost), desc:'所有賣出筆累計', tag:'Adequate', band:'—'},
      {name:'費用比 (Cost Ratio)', val:fmtPct(K.cost.costRatio), desc:'費用/成交額', tag:(K.cost.costRatio<=0.001?'Strong':(K.cost.costRatio<=0.003?'Adequate':'Improve')), band:'<0.10% / <0.30%'},
      {name:'成交額週轉率 (Turnover)', val:(K.cost.turnover).toFixed(2)+'x', desc:'成交額/本金', tag:(K.cost.turnover<=1?'Strong':(K.cost.turnover<=2?'Adequate':'Improve')), band:'1~2x'},
      {name:'筆均成交額 (Avg Trade Value)', val:fmtInt(K.cost.avgTradeValue), desc:'成交額/筆數', tag:(K.cost.avgTradeValue>=100000?'Strong':(K.cost.avgTradeValue>=30000?'Adequate':'Improve')), band:'≥100k / ≥30k'},
      {name:'買入總額 / 賣出總額', val:fmtInt(K.cost.grossBuy)+' / '+fmtInt(K.cost.grossSell), desc:'流動性利用',	tag:'Adequate', band:'—'},
      {name:'Omega(0%)', val:fmtPct(K.returns.Omega), desc:'P(R>0)/P(R<0)', tag:(K.returns.Omega>=1.5?'Strong':(K.returns.Omega>=1?'Adequate':'Improve')), band:'≥1.5 / ≥1.0'},
      {name:'MAR (CAGR/MaxDD)', val:(Math.abs(K.risk.maxDD)>0? (K.ratios.CAGR/Math.abs(K.risk.maxDD)):0).toFixed(2), desc:'等同 Calmar', tag:(Math.abs(K.risk.maxDD)>0 && (K.ratios.CAGR/Math.abs(K.risk.maxDD))>=1?'Strong':((Math.abs(K.risk.maxDD)>0 && (K.ratios.CAGR/Math.abs(K.risk.maxDD))>=0.3)?'Adequate':'Improve')), band:'≥1.0 / ≥0.3'}
    ];
    addRows('#kpiOptCost', cost);

    // 建議清單
    function pick(rows){ return rows.map(function(r){ return {name:r.name,val:r.val,desc:r.desc,tag:r.tag,band:r.band}; }); }
    var sugg = pick(ret).concat(pick(risk)).concat(pick(eff)).concat(pick(stab)).concat(pick(cost))
      .filter(function(x){ return x.tag.indexOf('Strong')<0; })
      .sort(function(a,b){ return (a.tag==='Improve'?0:1) - (b.tag==='Improve'?0:1); });
    addRows('#kpiOptSuggest', sugg);
  }

  /* ========== 基準（?benchmark / ?benchfile / ?benchurl） ========== */
  function loadBenchmark(days){
    var u = new URL(location.href);
    var tag = (u.searchParams.get('benchmark')||'').toUpperCase();
    var file= u.searchParams.get('benchfile')||'';
    var url = u.searchParams.get('benchurl')||'';
    var src = null;
    if (url) src = url;
    else if (file) src = pubUrl(file);
    else if (tag) src = pubUrl('benchmarks/'+tag+'.csv');
    if (!src) return Promise.resolve({ok:false, reason:'尚未連結基準（?benchmark=0050 / ?benchmark=TWII / ?benchfile= / ?benchurl=）'});

    return fetchText(src).then(function(txt){
      var lines = txt.replace(/\r\n?/g,'\n').split('\n').filter(Boolean);
      if (lines.length<2) return {ok:false, reason:'基準檔無資料行'};
      var head = lines[0].toLowerCase();
      var rows=[], i, d, close, ret;
      if (head.indexOf('ret')>=0){ // date,ret
        for (i=1;i<lines.length;i++){ var c=lines[i].split(/[, \t]+/); d=normalizeDate(c[0]); ret=parseFloat(c[1]); if(d && isFinite(ret)) rows.push({d:d, r:ret}); }
      }else{ // date,close
        var prev=null;
        for (i=1;i<lines.length;i++){ var cs=lines[i].split(/[, \t]+/); d=normalizeDate(cs[0]); close=parseFloat(cs[1]); if(d && close>0){ if(prev!=null){ rows.push({d:d, r:(close/prev-1)}); } prev=close; } }
      }
      var map = new Map(); rows.forEach(function(r){ map.set(r.d, r.r); });
      var bRets=[], sRets=[];
      // days: eq end-of-day list; rets length = days.length-1
      for (i=1;i<days.length;i++){
        var dd = days[i];
        if (map.has(dd)){ bRets.push(map.get(dd)); sRets.push(0); } // sRets 由外層傳入
      }
      return { ok:true, series: rows, map: map };
    });

    function normalizeDate(s){
      s = (s||'').trim();
      if (/^\d{8}$/.test(s)) return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      return null;
    }
  }

  function benchKPIs(days, stratDaily){
    return loadBenchmark(days).then(function(info){
      var tb = document.querySelector('#kpiOptBench tbody'); if(!tb) return;
      if(!info.ok){ tb.innerHTML = '<tr><td colspan="4">— '+info.reason+'</td></tr>'; return; }
      // 對齊
      var s=[], b=[];
      for (var i=1;i<days.length;i++){
        var d = days[i];
        if (info.map.has(d) && i-1 < stratDaily.length){ b.push(info.map.get(d)); s.push(stratDaily[i-1]); }
      }
      if (s.length<5){ tb.innerHTML = '<tr><td colspan="4">— 基準樣本不足</td></tr>'; return; }

      // IR / TE
      var n=s.length;
      var active = []; var i; for (i=0;i<n;i++) active.push(s[i]-b[i]);
      var meanA = active.reduce(function(a,c){return a+c;},0)/n;
      var sdA   = Math.sqrt(active.reduce(function(x,c){return x+Math.pow(c-meanA,2);},0)/n);
      var TE    = sdA*Math.sqrt(252);
      var IR    = TE>0 ? (meanA*252)/TE : 0;

      // 回歸 y = alpha + beta*x
      var mx = b.reduce(function(a,c){return a+c;},0)/n;
      var my = s.reduce(function(a,c){return a+c;},0)/n;
      var sxx=0, syy=0, sxy=0;
      for (i=0;i<n;i++){ var dx=b[i]-mx, dy=s[i]-my; sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy; }
      var beta = sxx>0? sxy/sxx : 0;
      var alpha = my - beta*mx;
      var r2 = (sxx>0&&syy>0)? (sxy*sxy)/(sxx*syy) : 0;
      var alphaAnn = alpha * 252;
      var treynor  = beta!==0 ? ( (my*252) - CFG.rf ) / beta : 0;

      // Capture
      var upIdx  = []; var dnIdx=[];
      for (i=0;i<n;i++){ if(b[i]>0) upIdx.push(i); else if(b[i]<0) dnIdx.push(i); }
      function avg(arr, src){ if(!arr.length) return null; var sum=0; for(var k=0;k<arr.length;k++) sum+=src[arr[k]]; return sum/arr.length; }
      var upCap = (upIdx.length && avg(upIdx,b)!=0) ? (avg(upIdx,s)/avg(upIdx,b)) : null;
      var dnCap = (dnIdx.length && avg(dnIdx,b)!=0) ? (avg(dnIdx,s)/avg(dnIdx,b)) : null;

      var rows = [
        ['Alpha (年化 Jensen)', (alphaAnn*100).toFixed(2)+'%', '回歸截距 × 252', '—'],
        ['Beta', beta.toFixed(3), '對市場敏感度', '—'],
        ['Information Ratio (IR)', IR.toFixed(2), '年化超額 / 追蹤誤差', '—'],
        ['Tracking Error (TE)', (TE*100).toFixed(2)+'%', '超額報酬標準差年化', '—'],
        ['R²', r2.toFixed(3), '回歸擬合度', '—'],
        ['Upside Capture', upCap==null?'—':upCap.toFixed(2), '基準上漲日：策略/基準', '—'],
        ['Downside Capture', dnCap==null?'—':dnCap.toFixed(2), '基準下跌日：策略/基準', '—'],
        ['Treynor Ratio', treynor.toFixed(2), '(年化超額)/Beta', '—']
      ];
      tb.innerHTML='';
      for (i=0;i<rows.length;i++){ var tr=document.createElement('tr'); tr.innerHTML='<td>'+rows[i][0]+'</td><td>'+rows[i][1]+'</td><td>'+rows[i][2]+'</td><td>'+rows[i][3]+'</td>'; tb.appendChild(tr); }
    });
  }

  /* ========== 目前持有（以最後未平倉段的所有 BUY 列出） ========== */
  function renderCurrentPosition(optExecs){
    var bar = document.getElementById('lastBuyBar'); if(!bar) return;
    // 找最後一個 SELL 的索引
    var lastSellIdx = -1;
    for (var i=optExecs.length-1;i>=0;i--){ if(optExecs[i].side==='SELL'){ lastSellIdx=i; break; } }
    var lines=[], held=0;
    for (var j = Math.max(0,lastSellIdx+1); j<optExecs.length; j++){
      var e = optExecs[j];
      if (e.side==='BUY'){ lines.push('買進　'+tsPretty(e.ts)+'　成交價格 <b>'+Number(e.price).toFixed(2)+'</b>　成交數量 <b>'+fmtInt(e.shares)+'</b>'); held += (e.shares||0); }
    }
    if (held<=0 || lines.length===0) { bar.style.display='none'; return; }
    bar.innerHTML = '目前持有：<br>'+lines.join('<br>')+'　持有數量 <b>'+fmtInt(held)+'</b>';
    bar.style.display='';
  }

  /* ========== 明細表（optExecs） ========== */
  function renderOptTable(optExecs){
    var thead = document.querySelector('#optTable thead');
    var tbody = document.querySelector('#optTable tbody');
    if (!thead || !tbody) return;
    thead.innerHTML = '<tr>'+
      '<th>種類</th><th>日期</th><th>成交價格</th><th>成本均價</th><th>成交數量</th>'+
      '<th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>'+
      '<th>成本</th><th>累計成本</th><th>損益</th><th>報酬率</th><th>累計損益</th></tr>';
    tbody.innerHTML='';
    for (var i=0;i<optExecs.length;i++){
      var e = optExecs[i];
      var tr = document.createElement('tr'); tr.className = (e.side==='BUY'?'buy-row':'sell-row');
      tr.innerHTML = '<td>'+(e.side==='BUY'?'買進':'賣出')+'</td>'+
        '<td>'+tsPretty(e.ts)+'</td>'+
        '<td>'+Number(e.price).toFixed(2)+'</td>'+
        '<td>'+(e.avgCost!=null? Number(e.avgCost).toFixed(2):'—')+'</td>'+
        '<td>'+fmtInt(e.shares||0)+'</td>'+
        '<td>'+fmtInt(e.buyAmount||0)+'</td>'+
        '<td>'+fmtInt(e.sellAmount||0)+'</td>'+
        '<td>'+fmtInt(e.fee||0)+'</td>'+
        '<td>'+fmtInt(e.tax||0)+'</td>'+
        '<td>'+fmtInt(e.cost||0)+'</td>'+
        '<td>'+fmtInt(e.cumCost||0)+'</td>'+
        '<td>'+(e.pnlFull==null?'—': (e.pnlFull>=0?'<span class="pnl-pos">'+fmtInt(e.pnlFull)+'</span>':'<span class="pnl-neg">'+fmtInt(e.pnlFull)+'</span>'))+'</td>'+
        '<td>'+(e.retPctUnit==null?'—':fmtPct(e.retPctUnit))+'</td>'+
        '<td>'+(e.cumPnlFull==null?'—': (e.cumPnlFull>=0?'<span class="pnl-pos">'+fmtInt(e.cumPnlFull)+'</span>':'<span class="pnl-neg">'+fmtInt(e.cumPnlFull)+'</span>'))+'</td>';
      tbody.appendChild(tr);
    }
  }

  /* ========== 主流程 ========== */
  function boot(){
    (async function(){
      try{
        setStatus('從 Supabase 讀取清單…');
        var u = new URL(location.href);
        var file = u.searchParams.get('file');
        var latest=null, lst=[];
        if (file) latest = { name:file.split('/').pop(), fullPath:file, from:'url' };
        else {
          lst = (await listCandidates()).filter(function(f){ return CFG.want.test(f.name)||CFG.want.test(f.fullPath); });
          // 依檔名日期分數 & 更新時間排序
          lst.sort(function(a,b){
            var sa=scoreDate(a.name), sb=scoreDate(b.name);
            if (sa!==sb) return sb-sa;
            if (a.updatedAt!==b.updatedAt) return b.updatedAt - a.updatedAt;
            return 0;
          });
          latest = lst[0];
        }
        if (!latest){ setStatus('找不到檔名含「00909」的 TXT（可用 ?file= 指定）', true); return; }
        var nm = document.getElementById('latestName'); if(nm) nm.textContent = latest.name;

        setStatus('下載最新檔…');
        var url = latest.from==='url'? latest.fullPath : pubUrl(latest.fullPath);
        var txt = await fetchText(url);

        setStatus('解析與回測…');
        var rows = window.ETF_ENGINE.parseCanon(txt);
        if (!rows || !rows.length){ setStatus('TXT 內無可解析的交易行。', true); return; }

        var start8 = rows[0].day, end8 = rows[rows.length-1].day;
        var pt = document.getElementById('periodText'); if (pt) pt.textContent = '期間：'+start8+' 開始到 '+end8+' 結束';

        var bt = window.ETF_ENGINE.backtest(rows, CFG);
        var optExecs = buildOptExecs(bt.execs);

        renderCurrentPosition(optExecs);
        renderWeeklyChart(optExecs);
        renderOptTable(optExecs);

        var K = computeKPIs(optExecs);
        if (K){
          // 補上 annRet for renderKPI 表頭使用
          K.returns.ann = K.returns.annRet;
          renderKPI(K);
          // 基準（可選）
          benchKPIs(K.period.days, K.returns.daily);
        }
        var btn = document.getElementById('btnSetBaseline'); if (btn) btn.disabled = true;
        setStatus('完成。');
      }catch(e){
        console.error('[00909 ERROR]', e);
        setStatus('初始化失敗：'+(e&&e.message?e.message:String(e)), true);
      }
    })();

    function scoreDate(name){
      var m = String(name||'').match(/\b(20\d{6})\b/g);
      if (!m) return 0;
      var max=0; for(var i=0;i<m.length;i++){ var v=+m[i]; if(v>max) max=v; }
      return max;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
