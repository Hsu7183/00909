// etf-00909.js — 00909專責：每週獲利(浮動長條)+累積淨利(折線) + KPI + 交易明細 + 最佳化交易明細
// 版本：kpi-opt-v6-full
(function(){
  const $=s=>document.querySelector(s);
  const status=$('#autostatus');
  const set=(m,err=false)=>{ if(status){ status.textContent=m; status.style.color=err?'#c62828':'#666'; } };

  // ===== 設定 =====
  const CFG={ symbol:'00909', bucket:'reports', want:/00909/i,
    manifestPath:'manifests/etf-00909.json',
    feeRate:0.001425, taxRate:0.001, minFee:20,
    tickSize:0.01, slippageTick:0, unitShares:1000, rf:0.00, initialCapital:1_000_000 };
  const OPT={ capital:1_000_000, unitShares:CFG.unitShares, ratio:[1,1,2] };

  // ===== Supabase =====
  const SUPABASE_URL="https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY="sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{ global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) } });
  const pubUrl=p=>{ const {data}=sb.storage.from(CFG.bucket).getPublicUrl(p); return data?.publicUrl||'#'; };

  // ===== 格式化工具 =====
  const fmtPct=v=> (v==null||!isFinite(v))?'—':(v*100).toFixed(2)+'%';
  const pnlSpan=v=>{ const cls=v>0?'pnl-pos':(v<0?'pnl-neg':''); return `<span class="${cls}">${Math.round(v||0).toLocaleString()}</span>`; };
  const tsPretty=ts14=>`${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;
  const rateLabel=l=> l==='Strong'?'Strong (強)':(l==='Adequate'?'Adequate (可)':'Improve (弱)');
  const rateHtml=l=>`<span class="${l==='Strong'?'rate-strong':(l==='Adequate'?'rate-adequate':'rate-improve')}">${rateLabel(l)}</span>`;

  // ===== 費率 Chips =====
  $('#feeRateChip').textContent=(CFG.feeRate*100).toFixed(4)+'%';
  $('#taxRateChip').textContent=(CFG.taxRate*100).toFixed(3)+'%';
  $('#minFeeChip').textContent=CFG.minFee;
  $('#unitChip').textContent=CFG.unitShares;
  $('#slipChip').textContent=CFG.slippageTick;
  $('#rfChip').textContent=(CFG.rf*100).toFixed(2)+'%';

  // ===== Supabase 讀取 =====
  async function listOnce(prefix){
    const p=(prefix && !prefix.endsWith('/'))?(prefix+'/'):(prefix||'');
    const {data,error}=await sb.storage.from(CFG.bucket).list(p,{limit:1000,sortBy:{column:'name',order:'asc'}});
    if(error) throw new Error(error.message);
    return (data||[]).map(it=>({name:it.name, fullPath:p+it.name, updatedAt:it.updated_at?Date.parse(it.updated_at):0}));
  }
  async function listCandidates(){ const u=new URL(location.href); const prefix=u.searchParams.get('prefix')||''; return listOnce(prefix); }
  const lastDateScore=name=>{ const m=String(name).match(/\b(20\d{6})\b/g); return m&&m.length? Math.max(...m.map(s=>+s||0)) : 0; };

  // ===== 下載 TXT =====
  async function fetchText(url){
    const res=await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf=await res.arrayBuffer(); const trials=['big5','utf-8','utf-16le','utf-16be','windows-1252'];
    for(const enc of trials){
      try{ return new TextDecoder(enc).decode(buf).replace(/\ufeff/gi,''); }catch{}
    }
    return new TextDecoder('utf-8').decode(buf);
  }

  // ===== 解析 Canonical TXT =====
  function parseCanon(text){
    const rows=[]; if(!text) return rows;
    const lines=text.replace(/\r\n?/g,'\n').split('\n');
    for(const raw of lines){
      const line=(raw||'').trim(); if(!line) continue;
      const m=line.match(/^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣)\s*$/);
      if(m){
        rows.push({ ts:m[1], tsMs:parseTs(m[1]), day:m[1].slice(0,8), price:+m[2], kind:m[3]==='平賣'?'sell':'buy' });
      }
    }
    return rows;
  }
  function parseTs(ts14){
    const Y=+ts14.slice(0,4), M=+ts14.slice(4,6)-1, D=+ts14.slice(6,8),
          h=+ts14.slice(8,10), m=+ts14.slice(10,12), s=+ts14.slice(12,14);
    return new Date(Date.UTC(Y,M,D,h,m,s)).getTime();
  }

  // ===== 回測主程式 =====
  function backtest(rows,cfg){
    const lot=cfg.unitShares, init=cfg.initialCapital;
    let shares=0, avgCost=0, cash=init, cumCost=0, cumPnl=0;
    const execs=[];
    for(const r of rows){
      if(r.kind==='buy'){
        const gross=r.price*lot, fee=Math.max(cfg.minFee,gross*cfg.feeRate);
        cash-=gross+fee; cumCost+=gross+fee;
        const newAvg=(shares*avgCost + r.price*lot)/(shares+lot);
        shares+=lot; avgCost=newAvg;
        execs.push({side:'BUY',ts:r.ts,tsMs:r.tsMs,price:r.price,shares:lot,fee,tax:0,cumCost,pnlFull:null});
      }
      if(r.kind==='sell' && shares>0){
        const gross=r.price*shares, fee=Math.max(cfg.minFee,gross*cfg.feeRate), tax=gross*cfg.taxRate;
        const pnl=gross - cumCost - (fee+tax); cumPnl+=pnl;
        cash+=gross-(fee+tax);
        execs.push({side:'SELL',ts:r.ts,tsMs:r.tsMs,price:r.price,shares,fee,tax,cumCost,pnlFull:pnl,cumPnl});
        shares=0; avgCost=0; cumCost=0;
      }
    }
    return {execs,cumPnl,lastCash:cash};
  }

  // ===== 每週獲利＋累積獲利 =====
  let chWeekly=null;
  function weekStartDate(ms){ const d=new Date(ms); const day=(d.getUTCDay()+6)%7; const s=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-day)); return s.toISOString().slice(0,10); }
  function buildWeeklyFromOpt(execs){
    const m=new Map(), order=[];
    for(const e of execs){
      if(e.side!=='SELL'||typeof e.pnlFull!=='number') continue;
      const wk=weekStartDate(e.tsMs);
      if(!m.has(wk)){ m.set(wk,0); order.push(wk); }
      m.set(wk,m.get(wk)+e.pnlFull);
    }
    const labels=order, weekly=labels.map(wk=>m.get(wk)||0), cum=[]; let s=0; for(const v of weekly){ s+=v; cum.push(s); }
    return {labels,weekly,cum};
  }
  function renderWeeklyChart(execs){
    const box=$('#weeklyCard'), ctx=$('#chWeekly'); const W=buildWeeklyFromOpt(execs);
    if(W.labels.length===0){ box.style.display='none'; return; } box.style.display='';
    const maxCum=Math.max(...W.cum,0), floatBars=[]; let prev=0; for(const c of W.cum){ floatBars.push([prev,c]); prev=c; }
    if(chWeekly) chWeekly.destroy();
    chWeekly=new Chart(ctx,{ data:{labels:W.labels,datasets:[
      {type:'bar',label:'每週獲利（浮動長條）',data:floatBars,borderWidth:1,backgroundColor:'rgba(13,110,253,0.3)',borderColor:'#0d6efd'},
      {type:'line',label:'累積淨利',data:W.cum,borderWidth:2,borderColor:'#f45b69',tension:0.2,pointRadius:0}
    ]}, options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true}},parsing:{yAxisKey:undefined},scales:{y:{suggestedMin:0,suggestedMax:maxCum*1.05},x:{ticks:{maxTicksLimit:12}}}}});
  }

  // ===== 表格渲染 =====
  function renderExecsTable(execs){
    const thead=$('#execTable thead'),tbody=$('#execTable tbody');
    thead.innerHTML=`<tr><th>種類</th><th>日期</th><th>成交價格</th><th>成交數量</th><th>手續費</th><th>交易稅</th><th>累計成本</th><th>損益</th></tr>`;
    tbody.innerHTML=''; for(const e of execs){
      const tr=document.createElement('tr'); tr.className=(e.side==='BUY'?'buy-row':'sell-row');
      tr.innerHTML=`<td>${e.side==='BUY'?'買進':'賣出'}</td><td>${tsPretty(e.ts)}</td><td>${e.price.toFixed(2)}</td><td>${e.shares}</td><td>${Math.round(e.fee)}</td><td>${Math.round(e.tax)}</td><td>${Math.round(e.cumCost)}</td><td>${e.pnlFull==null?'—':pnlSpan(e.pnlFull)}</td>`;
      tbody.appendChild(tr);
    }
  }
  function renderOptTable(execs){
    const thead=$('#optTable thead'),tbody=$('#optTable tbody');
    thead.innerHTML=`<tr><th>種類</th><th>日期</th><th>成交價格</th><th>成交數量</th><th>手續費</th><th>交易稅</th><th>損益</th></tr>`;
    tbody.innerHTML=''; for(const e of execs){
      const tr=document.createElement('tr'); tr.className=(e.side==='BUY'?'buy-row':'sell-row');
      tr.innerHTML=`<td>${e.side==='BUY'?'買進':'賣出'}</td><td>${tsPretty(e.ts)}</td><td>${e.price.toFixed(2)}</td><td>${e.shares}</td><td>${Math.round(e.fee)}</td><td>${Math.round(e.tax)}</td><td>${e.pnlFull==null?'—':pnlSpan(e.pnlFull)}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ===== KPI（簡版示意）=====
  function renderKPI(bt){
    $('#kpiOptCard').style.display='';
    const tb=$('#kpiOptSuggest tbody');
    tb.innerHTML=`<tr><td>累積獲利</td><td>${Math.round(bt.cumPnl).toLocaleString()}</td><td>—</td><td>${rateHtml('Strong')}</td><td>＞0</td></tr>`;
  }

  // ===== 主流程 =====
  async function boot(){
    try{
      const u=new URL(location.href);
      set('載入中…');
      let list=(await listCandidates()).filter(f=>CFG.want.test(f.name));
      list.sort((a,b)=>b.updatedAt-a.updatedAt);
      const latest=list[0];
      if(!latest){ set('找不到含00909的TXT'); return; }
      $('#latestName').textContent=latest.name;
      const txt=await fetchText(pubUrl(latest.fullPath));
      const rows=parseCanon(txt);
      const bt=backtest(rows,CFG);
      renderWeeklyChart(bt.execs);
      renderExecsTable(bt.execs);
      renderOptTable(bt.execs);
      renderKPI(bt);
      set('完成。');
    }catch(e){ set('錯誤：'+e.message,true); console.error(e); }
  }
  document.addEventListener('DOMContentLoaded',boot);
})();
