// ==UserScript==
// @name         C5⇄Steam 比价助手·调试HUD & 自检版 (Router+Backoff) by Marco
// @namespace    https://github.com/lang-marco
// @version      1.3.0
// @description  列表/详情比价 + 调试HUD + 自检 + SPA路由监听 + 429指数退避 + 多策略找链接 + 并发/抖动限流 + 自动排序/翻页 + 表达式自动点击 + (可选)自动汇率
// @match        https://www.c5game.com/*
// @icon         https://www.c5game.com/favicon.ico
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @connect      steamcommunity.com
// @connect      c5game.com
// ==/UserScript==

(function () {
  'use strict';

  // ===== 开关 =====
  const Debug = { debug: true, hudMaxLines: 140, bigToastMs: 5000 };

  // ===== 配置 =====
  const Config = {
    precision: 2,
    sellWarn: 0.70,
    buyWarn: 0.75,
    minOnSale: 1,

    // 汇率
    currencyMode: 'fixed',          // 'fixed' | 'auto'
    fixedCNY2Wallet: 1.0,
    rateTTLms: 3 * 60 * 60 * 1000,
    anchorListingUrl: '',

    // 限流（默认较保守；429 后会自动上调）
    histogramInterval: 900,         // 直方图基准间隔
    infoInterval: 650,
    concurrentMax: 3,

    // 自动化
    autoSort: 'sell-asc',           // 'none'|'sell-asc'|'sell-desc'|'buy-asc'|'buy-desc'
    autoFlip: false,
    autoClick: false,
    selectRule: '(sell < 0.70) && (buy < 0.75)',

    // 选择器
    selectors: {
      listCard: '.goodsCard, .goods-card, .c5-card',
      cardTitle: '.title, .name, .goods-name',
      cardPrice: '.price, .cny, .cost',
      onSaleCount: '.count, .stock, .onsale',
      cardLink: 'a[href*="/goods/"], a[href*="/detail"], a[href*="/csgo/"], a[href*="/dota2/"], a[href*="/app/"], a[href*="/trade/"]',
      nextBtn: '.pagination .btn-next, .el-pagination .btn-next',
      prevBtn: '.pagination .btn-prev, .el-pagination .btn-prev',
      listRoot: '#app, main, .nuxt, .goods-list',
      detailPrice: '.price, .goods-price, [data-role="price"]'
    },

    color: { good:'#12b886', warn:'#f59f00', bad:'#e03131', panelBg:'rgba(17,17,20,.88)', panelText:'#fff' }
  };

  // ===== 样式 & HUD =====
  GM_addStyle(`
    #c5s-hud{position:fixed;right:12px;top:12px;z-index:999999;width:360px;max-height:62vh;overflow:auto;border-radius:10px;background:${Config.color.panelBg};color:${Config.color.panelText};box-shadow:0 6px 24px rgba(0,0,0,.25);font:12px/1.4 ui-monospace,Consolas,Menlo,monospace}
    #c5s-hud header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.08)}
    #c5s-hud .dot{width:8px;height:8px;border-radius:50%;}
    #c5s-hud .ok{background:#2ecc71} .warn{background:#f1c40f} .err{background:#e74c3c}
    #c5s-hud .body{padding:6px 8px}
    #c5s-hud .row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
    #c5s-hud .tag{padding:2px 6px;border-radius:999px;background:rgba(255,255,255,.08)}
    #c5s-hud .btn{padding:3px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#fff;cursor:pointer}
    #c5s-hud pre{white-space:pre-wrap;margin:0}
    #c5s-banner{position:fixed;left:0;right:0;top:0;padding:10px 14px;background:#e03131;color:#fff;font:13px/1.3 system-ui;z-index:1000000;display:none}
    .c5s-badge{font:12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Inter,Roboto,Helvetica,Arial;display:inline-flex;gap:6px;align-items:center;padding:6px 8px;border-radius:8px;border:1px solid #e9ecef;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06);margin-top:6px}
    .c5s-chip{padding:2px 6px;border-radius:999px;font-weight:600}
    .c5s-chip.sell{background:#f1f3f5} .c5s-chip.buy{background:#f1f3f5}
    .c5s-chip.good{outline:2px solid ${Config.color.good}33}
    .c5s-chip.bad{outline:2px solid ${Config.color.bad}33}
    .c5s-chip.warn{outline:2px solid ${Config.color.warn}33}
    .c5s-selected{outline:2px solid #339af0;outline-offset:2px}
    .c5s-hl{outline:2px dashed #ff7a18;outline-offset:3px}
  `);

  const HUD = (() => {
    const banner = document.createElement('div');
    banner.id = 'c5s-banner';
    document.documentElement.appendChild(banner);

    const el = document.createElement('section');
    el.id = 'c5s-hud';
    el.innerHTML = `
      <header>
        <span class="dot ok" id="c5s-led"></span>
        <strong>比价 Debug HUD</strong>
        <div style="flex:1"></div>
        <button class="btn" id="c5s-btn-self">自检</button>
        <button class="btn" id="c5s-btn-hide">隐藏</button>
      </header>
      <div class="body">
        <div class="row">
          <span class="tag" id="c5s-tag-page">page:-</span>
          <span class="tag" id="c5s-tag-cards">cards:0</span>
          <span class="tag" id="c5s-tag-rate">rate:-</span>
          <span class="tag" id="c5s-tag-ctx">ctx:-</span>
          <span class="tag" id="c5s-tag-epoch">epoch:1</span>
          <span class="tag" id="c5s-tag-cool">cool:-</span>
          <span class="tag" id="c5s-tag-err">err:0</span>
        </div>
        <pre id="c5s-log"></pre>
      </div>`;
    document.documentElement.appendChild(el);

    el.querySelector('#c5s-btn-hide').onclick = () => el.remove();
    return {
      showBanner(msg, ms = Debug.bigToastMs) { banner.textContent = msg; banner.style.display = 'block'; setTimeout(() => banner.style.display = 'none', ms); },
      led(type){ const d = el.querySelector('#c5s-led'); d.className = 'dot ' + (type||'ok'); },
      set(tag, val){ const m = {page:'#c5s-tag-page',cards:'#c5s-tag-cards',rate:'#c5s-tag-rate',ctx:'#c5s-tag-ctx',err:'#c5s-tag-err',epoch:'#c5s-tag-epoch',cool:'#c5s-tag-cool'}; const e = el.querySelector(m[tag]); if (e) e.textContent = `${tag}:${val}`; },
      log(...args){
        if (!Debug.debug) return;
        console.log('[C5S]', ...args);
        const pre = el.querySelector('#c5s-log');
        let line = args.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ');
        pre.textContent = (pre.textContent + '\n' + line).split('\n').slice(-Debug.hudMaxLines).join('\n');
      },
      onSelfTest(handler){ el.querySelector('#c5s-btn-self').onclick = handler; },
      element: el,
    };
  })();

  window.addEventListener('error', (e) => { HUD.led('err'); HUD.set('err', +((HUD.element.dataset.err||0))+1); HUD.showBanner('脚本运行时错误：'+ e.message); HUD.log('ERROR:', e.message, e.filename, e.lineno); });
  window.addEventListener('unhandledrejection', (e) => { HUD.led('err'); HUD.showBanner('未捕获的 Promise 拒绝：'+ e.reason); HUD.log('UNHANDLED:', e.reason); });

  // ===== 工具 =====
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const parseFloatSafe = (s) => { const x = (''+(s??'')).replace(/[^0-9.,-]/g,'').replace(/,/g,''); const n = parseFloat(x); return Number.isFinite(n)?n:NaN; };

  // 费用互逆
  const Fee = {
    grossToNet(g) { return Math.floor(g * 85 / 100); },
    netToGross(n) { let g = Math.ceil(n / 0.85); while (Fee.grossToNet(g) < n) g++; return g; }
  };

  // 指数退避（针对 steamcommunity 主机）
  class Backoff {
    constructor({base=1000, factor=2, max=30000}={}) { this.base=base; this.factor=factor; this.max=max; this.level=0; this.until=0; }
    bump(seconds=null){ // seconds: 若从 Retry-After 来
      if (seconds!=null) this.until = Math.max(this.until, now()+seconds*1000);
      else { this.level = Math.min(this.level+1, 6); this.until = Math.max(this.until, now()+Math.min(this.base*Math.pow(this.factor,this.level), this.max)); }
    }
    ok(){ this.level = Math.max(this.level-1, 0); } // 成功可慢慢降级
    cooling(){ return now() < this.until; }
    remain(){ return Math.max(0, this.until - now()); }
  }
  const steamBackoff = new Backoff({ base: 4000, factor: 1.8, max: 120000 });

  // HTTP（带 429 识别 + 抖动）
  function httpText(method, url, data=null) {
    const t0 = performance.now();
    const jitter = 50 + Math.random()*200;
    return new Promise((resolve, reject) => {
      const go = () => GM_xmlhttpRequest({
        method, url, data,
        headers: { 'Accept':'*/*' },
        onload: (res) => {
          const dur = (performance.now()-t0).toFixed(0)+'ms';
          HUD.log('HTTP', res.status, url, dur);
          if (res.status === 429) { // Too Many Requests
            // 读取 Retry-After
            const ra = +(res.responseHeaders||'').match(/Retry-After:\s*(\d+)/i)?.[1] || null;
            steamBackoff.bump(ra);
            HUD.set('cool', (steamBackoff.remain()/1000).toFixed(0)+'s');
            HUD.showBanner('收到 429，进入冷却/退避中…');
            reject(new Error('HTTP 429'));
            return;
          }
          if (res.status >= 200 && res.status < 300) {
            // 成功：降级退避等级
            if (url.includes('steamcommunity.com')) steamBackoff.ok();
            resolve(res.responseText);
          } else {
            reject(new Error('HTTP '+res.status));
          }
        },
        onerror: (e) => {
          HUD.showBanner(`网络失败：${url}`);
          reject(new Error('NETWORK_ERROR'));
        }
      });
      // 如果目标处于冷却，先等
      if (url.includes('steamcommunity.com') && steamBackoff.cooling()) {
        HUD.set('cool', (steamBackoff.remain()/1000).toFixed(0)+'s');
        setTimeout(go, steamBackoff.remain()+jitter);
      } else {
        setTimeout(go, jitter);
      }
    });
  }
  const httpJson = (m,u,d=null)=>httpText(m,u,d).then(t=>{ try{return JSON.parse(t);}catch{return{};} });

  // 表达式
  function evalRule(rule, ctx) {
    const ok = /^[0-9\s()+\-*/.<>=!&|?_:\w]+$/u.test(rule||'');
    if (!ok) return false;
    const args = Object.keys(ctx), vals = Object.values(ctx);
    try { const fn = new Function(...args, `return (${rule});`); return !!fn(...vals); } catch { return false; }
  }

  // 简易限流器
  class Limiter {
    constructor({ interval=500, concurrent=2 }={}) { this.i=interval; this.c=concurrent; this.q=[]; this.a=0; }
    setInterval(ms){ this.i = ms; }
    push(task){ this.q.push(task); this.pump(); }
    pump(){ if (this.a>=this.c) return; const job=this.q.shift(); if(!job) return; this.a++; (async()=>{ try{ await job(); } finally { this.a--; setTimeout(()=>this.pump(), this.i + Math.random()*120); } })(); }
  }

  // ===== Steam 接口 =====
  const Steam = (() => {
    const cache = { nameid:new Map(), histo:new Map(), ctx:null, rate:null };

    async function ensureContext() {
      if (cache.ctx) return cache.ctx;
      const html = await httpText('GET','https://steamcommunity.com/market/'); // 解析语言/国家/货币
      const lang = (html.match(/g_strLanguage\s*=\s*"([^"]+)"/)||[])[1] || 'english';
      const ctry = (html.match(/g_strCountryCode\s*=\s*"([^"]+)"/)||[])[1] || 'US';
      const curr = Number((html.match(/"wallet_currency":\s*(\d+)/)||[])[1]) || 1;
      cache.ctx = { language:lang, country:ctry, currency:curr };
      HUD.set('ctx', `${lang}/${ctry}/c${curr}`);
      return cache.ctx;
    }

    async function getRateCNY2Wallet() {
      if (Config.currencyMode === 'fixed') { HUD.set('rate', Config.fixedCNY2Wallet); return Config.fixedCNY2Wallet; }
      const mem = GM_getValue('c5s_rate_cache', null);
      if (mem && now()-mem.ts < Config.rateTTLms) { cache.rate=mem; HUD.set('rate', mem.value); return mem.value; }
      if (!Config.anchorListingUrl) { HUD.showBanner('未配置自动汇率锚点，回退固定汇率'); HUD.set('rate', Config.fixedCNY2Wallet); return Config.fixedCNY2Wallet; }
      try {
        const html = await httpText('GET', Config.anchorListingUrl);
        const price = Number((html.match(/"price":\s*(\d+)/)||[])[1]);
        const cny   = Number((html.match(/"converted_price":\s*(\d+)/)||[])[1]);
        if (price>0 && cny>0) {
          const rate = price/cny;
          const obj = { ts: now(), value: rate };
          GM_setValue('c5s_rate_cache', obj); cache.rate=obj; HUD.set('rate', rate);
          return rate;
        }
      } catch {}
      HUD.showBanner('自动汇率失败，回退固定汇率');
      HUD.set('rate', Config.fixedCNY2Wallet);
      return Config.fixedCNY2Wallet;
    }

    async function getNameIdByHashName(appid, marketHashName) {
      const key = `${appid}/${marketHashName}`;
      if (cache.nameid.has(key)) return cache.nameid.get(key);
      const url = `https://steamcommunity.com/market/listings/${encodeURIComponent(appid)}/${encodeURIComponent(marketHashName)}`;
      const html = await httpText('GET', url);
      const m = html.match(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/);
      if (!m) throw new Error('item_nameid not found');
      cache.nameid.set(key, m[1]);
      return m[1];
    }

    async function getHistogram(nameid) {
      const ent = cache.histo.get(nameid);
      if (ent && (now()-ent.ts < 120000)) return ent;
      const ctx = await ensureContext();
      const u = new URL('https://steamcommunity.com/market/itemordershistogram');
      u.searchParams.set('country', ctx.country);
      u.searchParams.set('language', ctx.language);
      u.searchParams.set('currency', String(ctx.currency));
      u.searchParams.set('item_nameid', String(nameid));
      u.searchParams.set('two_factor','0');
      const json = await httpJson('GET', u.toString());
      const buy  = Number(json.highest_buy_order || 0);
      const sell = Number(json.lowest_sell_order || 0);
      if (!buy && !sell) { // 空结果也按退避处理（常见于限流）
        steamBackoff.bump();
        HUD.set('cool', (steamBackoff.remain()/1000).toFixed(0)+'s');
      }
      const obj = { ts: now(), buyHighest: buy, sellLowest: sell };
      cache.histo.set(nameid, obj);
      return obj;
    }

    return { ensureContext, getRateCNY2Wallet, getNameIdByHashName, getHistogram };
  })();

  // ===== 状态 & 路由监听 =====
  const State = {
    running:false,
    autoFlip:Config.autoFlip,
    autoClick:Config.autoClick,
    autoSort:Config.autoSort,
    epoch:1,
    lastUrl: location.href,
    listObserver: null
  };

  function isDetailPage(){
    // 路径或元素任一命中即判为详情页
    const pathHit = /\/(goods|detail|listing|product)\//.test(location.pathname);
    const elHit = !!document.querySelector(Config.selectors.detailPrice);
    return pathHit || elHit;
  }

  // 监听 SPA 路由变化：包裹 pushState/replaceState，并转发自定义事件（社区通行做法）
  (function patchHistory(){
    const rawPush = history.pushState, rawReplace = history.replaceState;
    function fire(){ window.dispatchEvent(new Event('locationchange')); }
    history.pushState = function(a,b,c){ const r = rawPush.apply(this, arguments); fire(); return r; };
    history.replaceState = function(a,b,c){ const r = rawReplace.apply(this, arguments); fire(); return r; };
    window.addEventListener('popstate', fire);
  })();

  window.addEventListener('locationchange', () => {
    if (State.lastUrl !== location.href) {
      HUD.log('route change:', State.lastUrl, '→', location.href);
      State.lastUrl = location.href;
      onRouteChanged();
    }
  });

  function onRouteChanged(){
    State.epoch++;
    HUD.set('epoch', State.epoch);
    HUD.set('page', isDetailPage() ? 'detail' : 'list');
    // 清除旧标记/旧徽章
    document.querySelectorAll('[data-c5s-epoch], .c5s-badge').forEach(el=>{
      el.removeAttribute('data-c5s-epoch');
      if (el.classList?.contains('c5s-badge')) el.remove();
    });
    // 重新挂观察器/跑一遍
    if (State.listObserver) { try { State.listObserver.disconnect(); } catch {} }
    if (isDetailPage()) { mountDetailPanel(); }
    watchList();
  }

  // ===== 自检（区分列表/详情） =====
  HUD.onSelfTest(async () => {
    try {
      HUD.log('>>> 自检开始');
      HUD.set('page', isDetailPage() ? 'detail' : 'list');
      if (isDetailPage()) {
        const priceEl = document.querySelector(Config.selectors.detailPrice);
        if (!priceEl) return HUD.showBanner('详情页：找不到价格元素（detailPrice）');
        const cny = parseFloatSafe(priceEl.textContent);
        if (!Number.isFinite(cny)) return HUD.showBanner('详情页：价格解析失败');
        HUD.showBanner('详情页自检通过');
        return;
      }
      const root = document.querySelector(Config.selectors.listRoot) || document.body;
      const cards = Array.from(document.querySelectorAll(Config.selectors.listCard));
      HUD.set('cards', cards.length);
      if (cards.length === 0) {
        HUD.led('warn');
        HUD.showBanner('列表页：未找到卡片！检查 selectors.listCard');
        root && root.classList.add('c5s-hl'); return;
      }
      cards.slice(0,3).forEach(el => el.classList.add('c5s-hl'));
      const pEl = cards[0].querySelector(Config.selectors.cardPrice);
      HUD.log('首卡价格文本：', pEl && pEl.textContent);
      const val = parseFloatSafe(pEl && pEl.textContent);
      if (!Number.isFinite(val)) return HUD.showBanner('列表页：价格解析失败（selectors.cardPrice）');
      const url = findDetailUrl(cards[0]);
      if (!url) { HUD.showBanner('列表页：未找到卡片链接（已高亮）'); cards[0].classList.add('c5s-hl'); return; }
      HUD.showBanner('列表页自检通过', 2500);
    } catch (e) {
      HUD.led('err'); HUD.showBanner('自检异常：' + (e && e.message || e)); HUD.log('自检异常：', e);
    }
  });

  // ===== 万能找链接 =====
  function findDetailUrl(card) {
    const tried = [];
    let a = card.querySelector(Config.selectors.cardLink);
    tried.push(`inner:${!!a}`);
    if (a && a.getAttribute('href')) return new URL(a.getAttribute('href'), location.origin).toString();

    a = card.closest('a[href*="/goods/"], a[href*="/detail"], a[href*="/csgo/"], a[href*="/dota2/"], a[href*="/app/"], a[href*="/trade/"]');
    tried.push(`closest:${!!a}`);
    if (a && a.getAttribute('href')) return new URL(a.getAttribute('href'), location.origin).toString();

    const cell = card.parentElement;
    if (cell) {
      a = cell.querySelector('a[href*="/goods/"], a[href*="/detail"], a[href*="/csgo/"], a[href*="/dota2/"], a[href*="/app/"], a[href*="/trade/"]');
      tried.push(`sibling:${!!a}`);
      if (a && a.getAttribute('href')) return new URL(a.getAttribute('href'), location.origin).toString();
    } else {
      tried.push('sibling:false');
    }

    const gid = card.getAttribute('data-goods-id') || card.dataset.id || card.dataset.goodsId;
    tried.push(`dataId:${!!gid}`);
    if (gid) return new URL(`/goods/${gid}`, location.origin).toString();

    try {
      const v = card.__vue__ || card.__vnode?.ctx;
      const vid = v?.goods?.id || v?.item?.id || v?.props?.goodsId;
      tried.push(`vueId:${!!vid}`);
      if (vid) return new URL(`/goods/${vid}`, location.origin).toString();
    } catch { tried.push('vueId:err'); }

    HUD.log('findDetailUrl failed →', tried.join(' | '));
    return null;
  }

  // ===== 详情页：计算器 =====
  async function mountDetailPanel() {
    const priceEl = document.querySelector(Config.selectors.detailPrice);
    if (!priceEl) return;
    const c5Price = parseFloatSafe(priceEl.textContent);
    if (!Number.isFinite(c5Price)) return;

    const old = document.getElementById('c5s-detail-panel');
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = 'c5s-detail-panel';
    panel.style.cssText = `position:fixed;right:12px;bottom:12px;background:${Config.color.panelBg};color:#fff;padding:12px;border-radius:10px;z-index:999999;font:12px/1.4 system-ui`;
    panel.innerHTML = `
      <div style="margin-bottom:6px;font-weight:700">C5 ⇄ Steam 计算器</div>
      <div> C5(¥) <input id="c5s-cny" style="width:110px" value="${c5Price.toFixed(2)}"> </div>
      <div> 净(分) <input id="c5s-net" style="width:110px"> 含(分) <input id="c5s-gross" style="width:110px"> </div>
      <div style="margin-top:6px">
        <button id="c5s-net2gross">净→含</button>
        <button id="c5s-gross2net">含→净</button>
      </div>
      <div id="c5s-ratio" style="margin-top:6px;opacity:.8">Sell/Buy: - / -</div>`;
    document.body.appendChild(panel);

    const rate = await Steam.getRateCNY2Wallet();
    const $ = id => panel.querySelector(id);
    $('#c5s-net2gross').onclick = () => { const n=Math.round(parseFloatSafe($('#c5s-net').value)||0); $('#c5s-gross').value=Fee.netToGross(n); update(); };
    $('#c5s-gross2net').onclick = () => { const g=Math.round(parseFloatSafe($('#c5s-gross').value)||0); $('#c5s-net').value=Fee.grossToNet(g); update(); };
    function update(){
      const cny = parseFloatSafe($('#c5s-cny').value)||0;
      const net = Math.round(parseFloatSafe($('#c5s-net').value)||0);
      const sell = (cny * rate * 100) / (net || Infinity);
      $('#c5s-ratio').textContent = `Sell/Buy: ${Number.isFinite(sell)?sell.toFixed(Config.precision):'-'} / ${Number.isFinite(sell)?sell.toFixed(Config.precision):'-'}`;
    }
  }

  // ===== 列表流程 =====
  let histoLimiter = new Limiter({ interval: Config.histogramInterval, concurrent: 1 });
  let infoLimiter  = new Limiter({ interval: Config.infoInterval,      concurrent: Config.concurrentMax });

  async function processList() {
    if (steamBackoff.cooling()) { HUD.set('cool', (steamBackoff.remain()/1000).toFixed(0)+'s'); return; }

    const rate = await Steam.getRateCNY2Wallet();
    const ctx  = await Steam.ensureContext();

    const cards = Array.from(document.querySelectorAll(Config.selectors.listCard))
      .filter(el => (el.dataset.c5sEpoch|0) !== State.epoch);
    HUD.set('cards', cards.length);
    if (cards.length === 0) return;

    const jobs = [];
    for (const card of cards) {
      card.dataset.c5sEpoch = String(State.epoch);

      // 清理旧徽章
      card.querySelectorAll('.c5s-badge').forEach(n=>n.remove());

      const pEl = card.querySelector(Config.selectors.cardPrice);
      const tEl = card.querySelector(Config.selectors.cardTitle);
      const cEl = card.querySelector(Config.selectors.onSaleCount);

      const cny = parseFloatSafe(pEl && pEl.textContent);
      const title = (tEl && tEl.textContent || '').trim();
      const detailUrl = findDetailUrl(card);
      const stock = parseFloatSafe(cEl && cEl.textContent) || 0;

      if (!Number.isFinite(cny) || !detailUrl || stock < Config.minOnSale) {
        if (!detailUrl) { card.classList.add('c5s-hl'); HUD.showBanner('卡片缺少可用链接（已高亮）', 2000); }
        continue;
      }

      const badge = document.createElement('div');
      badge.className = 'c5s-badge';
      badge.innerHTML = `
        <span style="opacity:.6">${ctx.language.toUpperCase()}/${ctx.country}</span>
        <span class="c5s-chip sell">Sell: <b class="v">…</b>%</span>
        <span class="c5s-chip buy">Buy: <b class="v">…</b>%</span>`;
      card.appendChild(badge);

      const job = async () => {
        try {
          const { appid, hash } = await getAppAndHash(detailUrl, title);
          await new Promise((resolve) => {
            histoLimiter.push(async () => {
              // 429 冷却时，动态加大间隔
              histoLimiter.setInterval( steamBackoff.cooling() ? Math.max(Config.histogramInterval, 2000) : Config.histogramInterval );
              const nameid = await Steam.getNameIdByHashName(appid, hash);
              const h = await Steam.getHistogram(nameid);
              const netSell = Fee.grossToNet(h.sellLowest);
              const netBuy  = Fee.grossToNet(h.buyHighest);
              const sellRatio = (cny * rate * 100) / (netSell || Infinity);
              const buyRatio  = (cny * rate * 100) / (netBuy  || Infinity);
              renderRatio(badge, sellRatio, buyRatio);
              tagForSort(card, sellRatio, buyRatio);
              autoSelectIfNeeded(card, sellRatio, buyRatio);
              resolve();
            });
          });
        } catch (e) {
          HUD.log('单卡失败：', e);
          badge.style.opacity = '.5';
          badge.title = '比价失败：' + (e && e.message || e);
        }
      };
      jobs.push(new Promise(res => infoLimiter.push(async () => { await job(); res(); })));
    }
    await Promise.allSettled(jobs);
    applyAutoSort();
    if (State.autoFlip) tryFlip();
  }

  function renderRatio(badge, sell, buy) {
    const s = badge.querySelector('.sell .v'), b = badge.querySelector('.buy .v');
    if (Number.isFinite(sell)) s.textContent = sell.toFixed(Config.precision);
    if (Number.isFinite(buy))  b.textContent = buy.toFixed(Config.precision);
    const sc = badge.querySelector('.sell'); sc.classList.remove('good','bad','warn');
    const bc = badge.querySelector('.buy');  bc.classList.remove('good','bad','warn');
    sc.classList.add(sell < Config.sellWarn ? 'good' : (sell > 1 ? 'bad' : 'warn'));
    bc.classList.add(buy  < Config.buyWarn  ? 'good' : (buy  > 1 ? 'bad' : 'warn'));
  }
  function tagForSort(card, sellRatio, buyRatio) {
    card.dataset.c5sSell = String(Number.isFinite(sellRatio)?sellRatio:9e9);
    card.dataset.c5sBuy  = String(Number.isFinite(buyRatio)?buyRatio:9e9);
  }
  function applyAutoSort() {
    if (State.autoSort === 'none') return;
    const cards = Array.from(document.querySelectorAll(Config.selectors.listCard));
    const key = State.autoSort.startsWith('sell') ? 'c5sSell' : 'c5sBuy';
    const asc = State.autoSort.endsWith('asc');
    cards.sort((a,b)=> (asc?1:-1)*(parseFloat(a.dataset[key]) - parseFloat(b.dataset[key])) )
         .forEach(el=>el.parentElement && el.parentElement.appendChild(el));
  }
  function autoSelectIfNeeded(card, sell, buy) {
    if (!State.autoClick) return;
    const ctx = { sell: Number.isFinite(sell)?sell:9e9, buy: Number.isFinite(buy)?buy:9e9, score:()=>1/(0.0001+ (sell||9e9)+(buy||9e9)) };
    if (evalRule(Config.selectRule, ctx)) {
      card.classList.add('c5s-selected');
      (card.querySelector('button, .btn, [role="button"]') || card.querySelector(Config.selectors.cardLink))?.click();
    }
  }

  // 详情信息获取
  async function getAppAndHash(detailUrl, fallbackTitle) {
    let html = null;
    try { html = await httpText('GET', new URL(detailUrl, location.origin).toString()); } catch {}
    const link = html && (html.match(/https:\/\/steamcommunity\.com\/market\/listings\/(\d+)\/([^"'<>]+)/) || []);
    if (link && link[1] && link[2]) return { appid: Number(link[1]), hash: decodeURIComponent(link[2]) };
    const appid = Number((html && (html.match(/"appid":\s*(\d+)/) || [])[1]) || 730);
    let hash = (html && (html.match(/"market_hash_name"\s*:\s*"([^"]+)"/) || [])[1]) || '';
    if (!hash) hash = fallbackTitle;
    if (!hash) throw new Error('market_hash_name not found');
    return { appid, hash };
  }

  // 翻页 & 热键 & 观察器
  function tryFlip(){ const next=document.querySelector(Config.selectors.nextBtn); if (next && !next.classList.contains('is-disabled')) next.click(); }
  function prevFlip(){ const prev=document.querySelector(Config.selectors.prevBtn); if (prev && !prev.classList.contains('is-disabled')) prev.click(); }
  window.addEventListener('keydown', (e)=>{
    if (e.altKey||e.ctrlKey||e.metaKey) return;
    const k=e.key.toLowerCase();
    if (k==='j'||k==='arrowright') tryFlip();
    if (k==='k'||k==='arrowleft')  prevFlip();
    if (k==='p'){ State.autoFlip=!State.autoFlip; HUD.showBanner(`自动翻页：${State.autoFlip?'开':'关'}`); }
    if (k==='x'){ State.autoClick=!State.autoClick; HUD.showBanner(`自动点击：${State.autoClick?'开':'关'}`); }
    if (k==='s'){
      const map=['none','sell-asc','sell-desc','buy-asc','buy-desc'];
      State.autoSort = map[(map.indexOf(State.autoSort)+1)%map.length];
      HUD.showBanner(`排序：${State.autoSort}`); applyAutoSort();
    }
  }, true);

  function watchList() {
    const root = document.querySelector(Config.selectors.listRoot) || document.body;
    if (State.listObserver) { try { State.listObserver.disconnect(); } catch {} }
    State.listObserver = new MutationObserver(()=>{ if (!State.running) return; processList(); });
    State.listObserver.observe(root, { childList:true, subtree:true });
    // 定时轻扫，兜底筛选切换/懒加载
    const tick = () => { processList(); setTimeout(tick, 1500); };
    setTimeout(tick, 1000);
    processList();
  }

  GM_registerMenuCommand('自检', ()=> HUD.element.querySelector('#c5s-btn-self').click());
  GM_registerMenuCommand('切换自动翻页', ()=>{ State.autoFlip=!State.autoFlip; HUD.showBanner(`自动翻页：${State.autoFlip?'开':'关'}`); });
  GM_registerMenuCommand('切换自动点击', ()=>{ State.autoClick=!State.autoClick; HUD.showBanner(`自动点击：${State.autoClick?'开':'关'}`); });
  GM_registerMenuCommand('设置固定汇率', ()=>{
    const v = prompt('输入人民币→钱包货币汇率（例 CNY→USD≈0.14）', String(Config.fixedCNY2Wallet));
    if (v){ Config.fixedCNY2Wallet = Number(v) || Config.fixedCNY2Wallet; GM_setValue('c5s_rate_cache',{ts:now(),value:Config.fixedCNY2Wallet}); HUD.set('rate', Config.fixedCNY2Wallet); }
  });
  GM_registerMenuCommand('清空汇率缓存', ()=>{ GM_setValue('c5s_rate_cache', null); HUD.showBanner('已清空汇率缓存'); });

  async function main(){
    HUD.set('page', isDetailPage() ? 'detail' : 'list');
    try { await Steam.ensureContext(); await Steam.getRateCNY2Wallet(); } catch {}
    State.running = true;
    if (isDetailPage()) { mountDetailPanel(); }
    watchList();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main, { once:true });
  else main();

})();
