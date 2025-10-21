// etf-engine.js — 全費口徑（含買方手續費）＋累計成本＋單位報酬率
// 版本：fullfee-v1
(function (root){
  const DAY_MS = 24*60*60*1000;
  const to6 = t => String(t||'').padStart(6,'0');
  function parseTs(ts14){
    const Y=+ts14.slice(0,4), M=+ts14.slice(4,6)-1, D=+ts14.slice(6,8),
          h=+ts14.slice(8,10), m=+ts14.slice(10,12), s=+ts14.slice(12,14);
    return new Date(Date.UTC(Y,M,D,h,m,s)).getTime();
  }
  const ymd = ms => new Date(ms).toISOString().slice(0,10).replace(/-/g,'');

  const CANON_RE = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣)\s*$/;

  // 解析 Canonical TXT 或 CSV
  function parseCanon(text){
    const rows=[]; if(!text) return rows;
    const norm=text.replace(/\ufeff/gi,'').replace(/\r\n?/g,'\n').replace(/\u3000/g,' ').replace(/，/g,',');
    const lines=norm.split('\n');
    for(const raw of lines){
      const line=(raw||'').trim(); if(!line) continue;
      if(/日期\s*[,|\t]\s*時間\s*[,|\t]\s*價格/i.test(line)) continue;
      let m=line.match(CANON_RE);
      if(m){
        rows.push({ ts:m[1], tsMs:parseTs(m[1]), day:m[1].slice(0,8),
                    price:+m[2], kind:(m[3]==='平賣'?'sell':'buy') });
        continue;
      }
      const parts=line.split(/[\t,]+/).map(s=>s.trim()).filter(Boolean);
      if(parts.length>=4){
        const d=parts[0]; if(!/^\d{8}$/.test(d)) continue;
        const t=to6(parts[1]), px=parts[2], zh=parts[3];
        if(isNaN(+px)) continue;
        const actTxt=(zh||'').replace(/\s+/g,'');
        let kind=null; if(/賣/.test(actTxt)) kind='sell'; else if(/買|加碼/.test(actTxt)) kind='buy';
        if(!kind) continue;
        const ts=d+to6(t);
        rows.push({ ts, tsMs:parseTs(ts), day:d, price:+px, kind });
      }
    }
    rows.sort((a,b)=>a.ts.localeCompare(b.ts));
    return rows;
  }

  // 費用計算
  function fees(price, shares, cfg, isSell){
    const gross=price*shares;
    const fee=Math.max(cfg.minFee, gross*cfg.feeRate);
    const tax=isSell ? gross*cfg.taxRate : 0;
    return { gross, fee, tax, total:fee+tax };
  }

  // 全費口徑回測
  function backtest(rows, cfg){
    const lot = cfg.unitShares ?? 1000;
    const init = cfg.initialCapital ?? 1_000_000;

    let shares=0, avgCost=0, cash=init;
    let cumCostFull=0, cumPnlAll=0, unitsInPeriod=0;
    const eqSeries=[], trades=[], execs=[];
    let openTs=null, openPx=null, buyFeeAcc=0;

    for(const r of rows){
      if(r.kind==='buy'){
        const qty=lot;
        const f=fees(r.price, qty, cfg, false);
        const cost=f.gross+f.fee;
        cash -= cost; cumCostFull += cost;
        const newAvg=(shares*avgCost + r.price*qty)/(shares+qty||1);
        shares+=qty; avgCost=newAvg;
        if(openTs==null){ openTs=r.ts; openPx=r.price; buyFeeAcc=0; }
        buyFeeAcc+=f.fee;
        execs.push({ side:'BUY', ts:r.ts, tsMs:r.tsMs, price:r.price,
          avgCost:newAvg, shares:qty,
          buyAmount:f.gross, sellAmount:0,
          fee:f.fee, tax:0,
          cost:cost, cumCost:cumCostFull,
          pnlFull:null, retPctUnit:null, cumPnlFull:cumPnlAll });
      }else if(r.kind==='sell' && shares>0){
        const qty=shares;
        const f=fees(r.price, qty, cfg, true);
        const pnlFull=f.gross - cumCostFull - (f.fee+f.tax);
        const retPctUnit=(cumCostFull>0)? (pnlFull/(cumCostFull)) : null;
        cumPnlAll+=pnlFull;
        cash += f.gross - f.fee - f.tax;
        trades.push({
          side:'LONG', inTs:openTs||r.ts, outTs:r.ts,
          inPx:openPx||avgCost, outPx:r.price,
          shares:qty, buyFee:buyFeeAcc, sellFee:f.fee, sellTax:f.tax,
          pnl:pnlFull
        });
        execs.push({ side:'SELL', ts:r.ts, tsMs:r.tsMs, price:r.price,
          avgCost:avgCost, shares:qty,
          buyAmount:0, sellAmount:f.gross,
          fee:f.fee, tax:f.tax,
          cost:0, cumCost:cumCostFull,
          pnlFull, retPctUnit, cumPnlFull:cumPnlAll });
        shares=0; avgCost=0; openTs=null; openPx=null; buyFeeAcc=0; cumCostFull=0;
      }
      const equity=cash+shares*r.price;
      eqSeries.push({t:r.tsMs,v:equity});
    }
    return { initial:init, eqSeries, trades, execs, lastCash:cash };
  }

  root.ETF_ENGINE={ parseCanon, backtest };
})(window);
