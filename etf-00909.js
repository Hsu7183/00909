// etf-00909.js — 00909專責：每週獲利(浮動長條)+累積淨利(折線) + KPI 置頂 + 基準型KPI + 月勝率
// 版本：kpi-opt-v6
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

  // chips
  $('#feeRateChip').textContent=(CFG.feeRate*100).toFixed(4)+'%';
  $('#taxRateChip').textContent=(CFG.taxRate*100).toFixed(3)+'%';
  $('#minFeeChip').textContent=CFG.minFee.toString();
  $('#unitChip').textContent=CFG.unitShares.toString();
  $('#slipChip').textContent=CFG.slippageTick.toString();
  $('#rfChip').textContent=(CFG.rf*100).toFixed(2)+'%';

  // ===== Supabase =====
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
  async function readManifest(){ try{ const {data}=await sb.storage.from(CFG.bucket).download(CFG.manifestPath); if(!data) return null; return JSON.parse(await data.text()); }catch{ return null; } }
  async function writeManifest(obj){ const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}); await sb.storage.from(CFG.bucket).upload(CFG.manifestPath,blob,{upsert:true,cacheControl:'0',contentType:'application/json'}); }

  // 多編碼下載
  async function fetchText(url){
    const res=await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf=await res.arrayBuffer(); const trials=['big5','utf-8','utf-16le','utf-16be','windows-1252'];
    let best={score:-1,txt:''};
    for(const enc of trials){
      let txt=''; try{ txt=new TextDecoder(enc,{fatal:false}).decode(buf).replace(/\ufeff/gi,''); }catch{ continue; }
      const head=txt.slice(0,1200), bad=(head.match(/\uFFFD/g)||[]).length, kw=(/日期|時間|動作|買進|賣出|加碼/.test(head)?1:0);
      const lines=(txt.match(/^\d{8}[,\t]\d{5,6}[,\t]\d+(?:\.\d+)?[,\t].+$/gm)||[]).length;
      const score=kw*1000 + lines*10 - bad; if(score>best.score) best={score,txt};
    }
    return best.txt || new TextDecoder('utf-8').decode(buf);
  }

  // ===== 共用格式化 =====
  const fmtPct=v=> (v==null||!isFinite(v))?'—':(v*100).toFixed(2)+'%';
  const pnlSpan=v=>{ const cls=v>0?'pnl-pos':(v<0?'pnl-neg':''); return `<span class="${cls}">${Math.round(v||0).toLocaleString()}</span>`; };
  const rateLabel=l=> l==='Strong'?'Strong (強)':(l==='Adequate'?'Adequate (可)':'Improve (弱)');
  const rateHtml=l=>`<span class="${l==='Strong'?'rate-strong':(l==='Adequate'?'rate-adequate':'rate-improve')}">${rateLabel(l)}</span>`;
  const tsPretty=ts14=>`${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;

  // ===== 每週獲利＋累積淨利圖 =====
  let chWeekly=null;
  function weekStartDate(ms){
    const d=new Date(ms); const day=(d.getUTCDay()+6)%7;
    const start=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-day));
    return start.toISOString().slice(0,10);
  }
  function buildWeeklyFromOpt(optExecs){
    const m=new Map(); const order=[];
    for(const e of optExecs){
      if(e.side!=='SELL' || typeof e.pnlFull!=='number') continue;
      const wk=weekStartDate(e.tsMs);
      if(!m.has(wk)){ m.set(wk,0); order.push(wk); }
      m.set(wk, m.get(wk)+e.pnlFull);
    }
    const labels=order;
    const weekly=labels.map(wk=>m.get(wk)||0);
    const cum=[]; let s=0; for(const v of weekly){ s+=v; cum.push(s); }
    return { labels, weekly, cum };
  }
  function renderWeeklyChart(optExecs){
    const box=$('#weeklyCard'); const ctx=$('#chWeekly'); if(!ctx) return;
    const W=buildWeeklyFromOpt(optExecs);
    if(W.labels.length===0){ box.style.display='none'; return; }
    box.style.display='';
    const maxCum=Math.max(...W.cum,0);
    const floatBars=[]; let prev=0;
    for(const c of W.cum){ floatBars.push([prev,c]); prev=c; }
    if(chWeekly) chWeekly.destroy();
    chWeekly=new Chart(ctx,{
      data:{
        labels:W.labels,
        datasets:[
          { type:'bar', label:'每週獲利（浮動長條）', data:floatBars, borderWidth:1, backgroundColor:'rgba(13,110,253,0.3)', borderColor:'#0d6efd' },
          { type:'line', label:'累積淨利', data:W.cum, borderWidth:2, borderColor:'#f45b69', tension:0.2, pointRadius:0 }
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:true } },
        parsing:{ yAxisKey:undefined },
        scales:{
          y:{ suggestedMin:0, suggestedMax: Math.max(maxCum*1.05, 1) },
          x:{ ticks:{ maxTicksLimit:12 } }
        }
      }
    });
  }

  // ===== 主流程 =====
  async function boot(){
    try{
      const u=new URL(location.href); const paramFile=u.searchParams.get('file');
      let latest=null, list=[];
      if(paramFile){ latest={ name:paramFile.split('/').pop()||'00909.txt', fullPath:paramFile, from:'url' }; }
      else{
        set('從 Supabase（reports）讀取清單…');
        list=(await listCandidates()).filter(f=>CFG.want.test(f.name)||CFG.want.test(f.fullPath));
        list.sort((a,b)=>{ const sa=lastDateScore(a.name), sb=lastDateScore(b.name);
          if(sa!==sb) return sb-sa; if(a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt; return (b.size||0)-(a.size||0); });
        latest=list[0];
      }
      if(!latest){ set('找不到檔名含「00909」的 TXT（可用 ?file= 指定）。',true); return; }
      $('#latestName').textContent=latest.name;

      const latestUrl= latest.from==='url'? latest.fullPath : pubUrl(latest.fullPath);
      const txtNew = await fetchText(latestUrl);
      const rowsNew = window.ETF_ENGINE.parseCanon(txtNew);
      if(rowsNew.length===0){ set('最新檔沒有可解析的交易行。',true); return; }

      const bt = window.ETF_ENGINE.backtest(rowsNew, CFG);
      const optExecs = bt.execs;
      renderWeeklyChart(optExecs);
      set('完成。');
    }catch(err){
      set('初始化失敗：'+(err && err.message ? err.message : String(err)), true);
      console.error('[00909 ERROR]', err);
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
