// ==UserScript==
// @name         FUT Portfolio Collector
// @namespace    miguel.fut.portfolio
// @version      1.7
// @description  Read-only snapshot of the FC web app Transfer List and Transfer Targets, sent to your Google Sheet every ~20 minutes.
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app/*
// @match        https://www.ea.com/*/ea-sports-fc/ultimate-team/web-app/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      docs.google.com
// @connect      googleusercontent.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/notevenmex/fut-collector/main/fut-collector.user.js
// @downloadURL  https://raw.githubusercontent.com/notevenmex/fut-collector/main/fut-collector.user.js
// ==/UserScript==

/*
  This script never buys, bids, lists, relists, quick-sells or clears anything.
  The automatic snapshot only opens the Transfer List and Transfer Targets pages, selects rows to read "Bought For",
  and opens Player Bio once per new card to read gems, rarity, nation, club and league.
  The Hero/Icon market scan runs only when you start it from the Tampermonkey menu. It searches the market and
  presses "Watch" (adds to Transfer Targets) on qualifying listings, nothing else.
  After each snapshot, the off-list price check searches the market for every card that has left your Transfer List, once an hour
  (the Apps Script picks them) and only reads the results: no Watch, no alerts. Its searches count toward the daily and hourly caps.

  Safety rules built in:
  - Waits until you have been idle (no mouse/keyboard) for IDLE_MIN minutes, so it never takes over while you trade.
  - Runs on a randomised 17–25 minute interval, not a fixed clock.
  - Stops for the session if the app shows "Cannot Authenticate" or any captcha/verification prompt.
*/

(() => {
  'use strict';

  // ---- settings ----
  // The web app URL and secret are kept in Tampermonkey storage, not in this file: set them once with the menu command
  // "Set web app URL and secret". Pasting a new version of this script keeps them.
  const cfg = () => ({ url: GM_getValue('webappUrl', ''), secret: GM_getValue('secret', '') });
  const MIN_GAP_MIN = 17, MAX_GAP_MIN = 25;   // random gap between runs
  const IDLE_MIN = 3;                          // only run after this many minutes without your input

  const sl = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (s) => (s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0);
  const clean = (s) => s.replace(/This card is in your Gallery collection\s*/g, '').replace(/\s+/g, ' ').trim();
  const log = (...a) => console.log('[FUT collector]', ...a);

  let lastInput = Date.now();
  ['mousedown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, (e) => { if (e.isTrusted) lastInput = Date.now(); }, true));

  const tap = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) =>
      el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o)));
  };
  const visible = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent);
  const navButton = (label) => visible('button').find((b) => b.innerText.trim() === label);
  const blocked = () => /Cannot Authenticate|verification|captcha|unusual activity/i.test(document.body.innerText);

  const nameOf = (t) => (t.match(/^\d+\s+[A-Z]{2,3}(?:\s+[A-Z]{2,3})*\s+(?:[\d,]+\s+)?(.+?)\s+(?:PAC|DIV)\s/) || [])[1] || t.slice(0, 30);
  const enhOf = (t) => { const m = t.match(/^\d+\s+[A-Z]{2,3}(?:\s+[A-Z]{2,3})*\s+([\d,]+)\s+/); return m ? num(m[1]) : null; };
  const field = (t, re) => { const m = t.match(re); return m ? m[1] : null; };
  const sectionOf = (li) => (li.closest('section')?.querySelector('h2')?.innerText || '').trim();

  async function openTile(title) {
    const nav = navButton('Transfers');
    if (!nav) throw new Error('Transfers button not found');
    tap(nav);
    for (let k = 0; k < 20; k++) {
      await sl(500);
      const tile = visible('div').filter((d) => d.innerText.trim().startsWith(title) && d.getBoundingClientRect().height > 100)
        .sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (tile) { tap(tile); await sl(4000); return; }
    }
    throw new Error(title + ' tile not found');
  }

  function readRow(li) {
    const t = clean(li.innerText);
    const bid = field(t, /Bid\s*(?:\([^)]*\)\s*)?([\d,]+|---)/);
    const r = readRowBase(li, t, bid);
    // Holographic cards render the name twice with the Enhancer price between them: "Marquinhos 425,000 Marquinhos".
    const dup = r.player.match(/^(.+?)\s+(?:([\d,]+)\s+)?\1$/);
    if (dup) { r.player = dup[1] + ' (Holo)'; if (r.enh == null && dup[2]) r.enh = num(dup[2]); r.holo = true; }
    return r;
  }
  function readRowBase(li, t, bid) {
    return {
      sec: sectionOf(li), player: nameOf(t), rating: num(t.split(' ')[0]), pos: t.split(' ')[1] || '',
      enh: enhOf(t), start: num(field(t, /Start Price:\s*(?:\([^)]*\)\s*)?([\d,]+)/)),
      bid: bid && bid !== '---' ? num(bid) : 0, bn: num(field(t, /Buy Now:\s*(?:\([^)]*\)\s*)?([\d,]+)/)),
      time: (field(t, /Time\s+(.+)$/) || '').trim(),
    };
  }

  // Detail panel of the selected row: "Bought For" and, for unlisted items, the price range.
  function readPanel() {
    const els = visible('*').filter((e) => /Bought For/i.test(e.innerText || '') && (e.innerText || '').length < 900)
      .sort((a, b) => a.innerText.length - b.innerText.length);
    const t = els.map((e) => clean(e.innerText)).find((x) => /Bought For\s*[\d,]+/i.test(x)) || '';
    return { bought: num(field(t, /Bought For\s*([\d,]+)/i)) || null };
  }

  async function readRange() {
    let p = visible('*').filter((e) => /Start Price/i.test(e.innerText || '') && /Min:|Max:/.test(e.innerText || '') && (e.innerText || '').length < 900)
      .sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!p) {
      // Expands the listing form only; never presses "List for Transfer".
      const h = visible('button,div,span').filter((e) => (e.innerText || '').trim() === 'List on Transfer Market')
        .sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (!h) return null;
      tap(h); await sl(1200);
      p = visible('*').filter((e) => /Start Price/i.test(e.innerText || '') && /Min:|Max:/.test(e.innerText || '') && (e.innerText || '').length < 900)
        .sort((a, b) => a.innerText.length - b.innerText.length)[0];
    }
    if (!p) return null;
    const t = clean(p.innerText);
    const max = num(field(t, /Max:\s*([\d,]+)/));
    return max ? { min: num(field(t, /Min:\s*([\d,]+)/)), max } : null;
  }

  async function readBio() {
    const b = visible('button').find((x) => /^Player Bio/.test(x.innerText.trim()));
    if (!b) return null;
    tap(b);
    for (let j = 0; j < 8; j++) {
      await sl(400);
      const t = clean(document.body.innerText);
      const m = t.match(/Score:\s*([\d,]+)/);
      if (m) return {
        gems: num(m[1]), rarity: field(t, /Rarity\s+(.+?)\s+Full Name/) || '',
        pos: field(t, /Preferred Position\s+(\S+)/) || '', alt: field(t, /Alternate positions\s+(.+?)\s+Preferred Foot/) || '',
        nation: field(t, /Country\/Region\s+(.+?)\s+Club/) || '', club: field(t, /Club\s+(.+?)\s+League/) || '',
        league: field(t, /League\s+(.+?)\s+Item Details/) || '',
      };
    }
    return null;
  }

  // The Transfer List can still be rendering after openTile's wait: count rows until two checks in a row agree.
  async function settledCount() {
    let last = -1;
    for (let k = 0; k < 12; k++) {
      const n = document.querySelectorAll('li.listFUTItem').length;
      if (n > 0 && n === last) return n;
      last = n; await sl(700);
    }
    return Math.max(last, 0);
  }

  async function snapshot() {
    const known = GM_getValue('knownCards', {});   // cards whose bio and range we already have
    const cards = {};
    await openTile('Transfer List');
    const rows = [];
    const n = await settledCount();
    for (let i = 0; i < n; i++) {
      if (blocked()) throw new Error('blocked');
      const li = document.querySelectorAll('li.listFUTItem')[i];
      // The list changed under us: fail this run rather than send a partial list. The next run tries again.
      if (!li) throw new Error('transfer list changed mid-read (' + i + ' of ' + n + ' rows)');
      const r = readRow(li);
      li.scrollIntoView({ block: 'center' });
      tap(li.querySelector('.rowContent') || li);
      await sl(700 + Math.random() * 500);
      Object.assign(r, readPanel());
      const key = r.player + '|' + r.rating;
      const k = known[key] || {};
      if (!k.max && r.sec === 'Available Items') { const rg = await readRange(); if (rg) Object.assign(k, rg); }
      if (!k.gems && r.sec !== 'Sold Items') { const bio = await readBio(); if (bio) Object.assign(k, bio); }
      if (Object.keys(k).length) { known[key] = k; cards[key] = k; }
      rows.push(r);
    }
    GM_setValue('knownCards', known);

    await openTile('Transfer Targets');
    // FC Enhancer fills its prices in a moment after the list renders: wait until most rows have one.
    let watch = [];
    for (let k = 0; k < 10; k++) {
      watch = [...document.querySelectorAll('li.listFUTItem')].map(readRow);
      if (!watch.length || watch.filter((r) => r.enh != null).length >= watch.length * 0.8) break;
      await sl(800);
    }
    const balance = num(document.querySelector('.view-navbar-currency-coins')?.innerText);
    return { secret: cfg().secret, at: new Date().toISOString(), balance, rows, watch, cards };
  }

  function send(payload) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url: cfg().url, data: JSON.stringify(payload),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      onload: (res) => resolve(res.responseText), onerror: reject, ontimeout: reject, timeout: 30000,
    }));
  }

  // Promo dip alerts come back from the Apps Script once the scan is saved.
  function notifyAlerts(res) {
    let a = [];
    try { a = (JSON.parse(res).alerts) || []; } catch (e) { return; }
    if (!a.length) return;
    const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.round(n / 1000) + 'k');
    const text = a.map((x) => `${x.kind === 'holo_spike' ? 'HOLO SPIKE ' : ''}${x.card}: ${k(x.now)} (${x.drop > 0 ? '+' : ''}${(x.drop * 100).toFixed(1)}% vs today's low ${k(x.prior_low)})`).join('\n');
    log('PRICE ALERT', text);
    const spikes = a.filter((x) => x.kind === 'holo_spike').length, dips = a.length - spikes;
    GM_notification({ title: [dips ? `Promo dip: ${dips} card${dips > 1 ? 's' : ''} 5%+ under today's low` : '', spikes ? `Holo spike: ${spikes} card${spikes > 1 ? 's' : ''} 10%+ over today's low` : ''].filter(Boolean).join(' · '), text, timeout: 0 });
  }

  let stopped = false, running = false, timer = null;
  async function tick(manual) {
    if (stopped && !manual) return;
    if (running) { log('a run is already in progress'); return; }
    if (typeof scanning !== 'undefined' && scanning) { log('market scan running, snapshot in 5 min'); return schedule(5); }
    const idleMin = (Date.now() - lastInput) / 60000;
    if (!manual && idleMin < IDLE_MIN) { log('you are active, retry in 5 min'); return schedule(5); }
    if (blocked()) { stopped = true; log('app shows a login/verification prompt; stopping until reload'); return; }
    if (!navButton('Transfers')) { log('web app not ready, retry in 5 min'); return schedule(5); }
    running = true;
    try {
      const payload = await snapshot();
      const res = await send(payload);
      log('sent', payload.rows.length, 'transfer-list rows,', payload.watch.length, 'watched;', res);
      notifyAlerts(res);
      GM_setValue('lastRun', payload.at);
      running = false;
      await offlistCheck(res);
    } catch (e) {
      if (String(e).includes('blocked')) { stopped = true; log('stopped: login/verification prompt'); return; }
      log('run failed:', e);
    } finally { running = false; }
    if (stopped) return;
    schedule(MIN_GAP_MIN + Math.random() * (MAX_GAP_MIN - MIN_GAP_MIN));
  }
  function schedule(min) { clearTimeout(timer); timer = setTimeout(() => tick(false), min * 60000); log('next run in', min.toFixed(1), 'min'); }

  // ======================= Hero / Icon market scan (manual start only) =======================
  // Reads the PC price sheet, then for each card with PC Min in [SCAN_MIN, SCAN_MAX] (cheapest first):
  //   search Buy Now <= Min, and (optionally) auctions with bid <= 95% of Min.
  //   Buy Now <= Min              -> Watch (add to Transfer Targets)
  //   Buy Now <= 95% of Min       -> Watch + pop-up + pause the scan
  //   Auction <= 95% of Min, <20m -> Watch + pop-up + pause the scan
  //   Other auctions <= Min       -> Watch only
  // It never buys, bids, lists or clears. It stops on login/verification prompts or any "too many requests" style message.
  const PC_SHEET_CSV = 'https://docs.google.com/spreadsheets/d/13InQxkXD5D-beqnfL3-hoj6drDkHUBcVtgOWCHDOFj4/gviz/tq?tqx=out:csv&sheet=PC';
  const SCAN_MIN = 150000, SCAN_MAX = 1000000;   // PC Min range to scan
  const CHECK_AUCTIONS = true;                    // second search per card for auctions (doubles the searches)
  const CARDS_PER_RUN = 20;                       // a run stops after this many cards; start again to continue
  const DAILY_SEARCH_CAP = 500;                   // hard stop for the day (ET), to stay well clear of EA's limits
  const HOURLY_SEARCH_CAP = 40;                   // at most this many searches in any 60 minutes, so they spread through the day
  const SEARCH_GAP = [6000, 11000];               // random wait between searches (ms)

  let scanning = false, scanStop = false;
  const rnd = ([a, b]) => a + Math.random() * (b - a);
  const marketBlocked = () => /too many|temporarily (?:unavailable|blocked)|transfer market is (?:currently )?unavailable|try again later|unusual activity/i.test(document.body.innerText);
  const k$ = (n) => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.round(n / 1000) + 'k');
  const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const etDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  // Why searching has to stop now, or null: the daily cap (ET day) or the rolling hourly cap.
  const capHit = () => {
    const u = GM_getValue('scanSearches', {});
    if (u.day === etDay() && u.n >= DAILY_SEARCH_CAP) return `daily cap of ${DAILY_SEARCH_CAP} searches reached`;
    if (GM_getValue('searchTimes', []).filter((t) => Date.now() - t < 3600000).length >= HOURLY_SEARCH_CAP) return `hourly cap of ${HOURLY_SEARCH_CAP} searches reached`;
    return null;
  };

  function getText(url) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'GET', url, onload: (r) => (r.status === 200 ? resolve(r.responseText) : reject(new Error('sheet HTTP ' + r.status))), onerror: reject, timeout: 30000 }));
  }
  function parseCsv(t) {
    const out = []; let row = [], cur = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '"' && t[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
    }
    if (cur || row.length) { row.push(cur); out.push(row); }
    return out;
  }
  async function loadPcList() {
    const rows = parseCsv(await getText(PC_SHEET_CSV));
    const head = rows.shift().map((h) => h.toLowerCase());
    const col = (re, dflt) => { const i = head.findIndex((h) => re.test(h)); return i >= 0 ? i : dflt; };
    const c5 = col(/5\s*-?\s*d|five/, 6);
    const cMin = head.findIndex((h, i) => /min/.test(h) && i !== c5); const C = {
      name: col(/name|player|card/, 0), rating: col(/rat|ovr/, 1), avg: col(/avg|average/, 2),
      min: cMin >= 0 ? cMin : 3, max: col(/max/, -1), d5: c5,
    };
    log('PC sheet columns', head.join(' | '), '→ using', JSON.stringify(C));
    return rows.map((r) => ({ name: (r[C.name] || '').trim(), rating: num(r[C.rating]), avg: num(r[C.avg]), min: num(r[C.min]), max: C.max >= 0 ? num(r[C.max]) : null, d5: num(r[C.d5]) }))
      .filter((r) => r.name && r.rating && r.min >= SCAN_MIN && r.min <= SCAN_MAX)
      .sort((a, b) => a.min - b.min);
  }

  function setInput(el, v) {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    ['input', 'keyup', 'change'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
    el.blur();
  }
  const searchPage = () => visible('input').find((i) => /player name/i.test(i.placeholder || ''));
  async function openSearch() {
    if (searchPage()) return;
    const back = visible('button.ut-navigation-button-control')[0];
    if (back && /search results/i.test(document.body.innerText.slice(0, 400))) { tap(back); await sl(1500); if (searchPage()) return; }
    await openTile('Search the Transfer Market');
    for (let k = 0; k < 10 && !searchPage(); k++) await sl(500);
    if (!searchPage()) throw new Error('search page not found');
  }
  async function pickPlayer(card) {
    const box = searchPage();
    setInput(box, ''); await sl(300);
    setInput(box, card.name); box.focus();
    box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: card.name.slice(-1) }));
    let btn = null;
    for (let k = 0; k < 12 && !btn; k++) {
      await sl(400);
      const want = fold(card.name);
      btn = visible('button').filter((b) => { const t = b.innerText.replace(/\s+/g, ' ').trim(); return t.length < 70 && new RegExp('\\b' + card.rating + '$').test(t); })
        .find((b) => { const f = fold(b.innerText.replace(/\d+\s*$/, '')); return f === want || f.includes(want) || want.includes(f); });
    }
    if (!btn) return false;
    tap(btn); await sl(800);
    return true;
  }
  function priceInputs() {
    // Order on the search page: Bid min, Bid max, Buy Now min, Buy Now max.
    const ins = visible('input').filter((i) => i.classList.contains('ut-number-input-control') || (i.inputMode === 'numeric' && !/player name/i.test(i.placeholder || '')));
    return ins.length >= 4 ? { bidMax: ins[1], bnMin: ins[2], bnMax: ins[3], bidMin: ins[0] } : null;
  }
  async function runSearch(bidMax, bnMax) {
    const p = priceInputs(); if (!p) throw new Error('price inputs not found');
    setInput(p.bidMin, ''); setInput(p.bnMin, '');
    setInput(p.bidMax, bidMax ? String(bidMax) : ''); setInput(p.bnMax, bnMax ? String(bnMax) : '');
    await sl(400);
    const go = visible('button').find((b) => b.innerText.trim() === 'Search');
    if (!go) throw new Error('search button not found');
    await sl(rnd(SEARCH_GAP));
    tap(go);
    GM_setValue('scanSearches', { day: etDay(), n: (GM_getValue('scanSearches', {}).day === etDay() ? GM_getValue('scanSearches', {}).n : 0) + 1 });
    GM_setValue('searchTimes', GM_getValue('searchTimes', []).filter((t) => Date.now() - t < 3600000).concat(Date.now()));
    for (let k = 0; k < 16; k++) {
      await sl(500);
      if (blocked() || marketBlocked()) throw new Error('blocked');
      if (document.querySelectorAll('li.listFUTItem').length || /no results/i.test(document.body.innerText)) break;
    }
    return [...document.querySelectorAll('li.listFUTItem')].map((li) => {
      const t = clean(li.innerText);
      const bid = field(t, /Bid\s*(?:\([^)]*\)\s*)?([\d,]+|---)/), sp = field(t, /Start Price:\s*(?:\([^)]*\)\s*)?([\d,]+)/);
      const tm = (field(t, /Time\s+(.+)$/) || '').trim();
      const mins = /second/i.test(tm) ? 0 : /minute/i.test(tm) ? num(tm) : /hour/i.test(tm) ? num(tm) * 60 : 9999;
      return { li, text: t, rating: num(t.split(' ')[0]), bid: bid && bid !== '---' ? num(bid) : 0, start: num(sp), bn: num(field(t, /Buy Now:\s*(?:\([^)]*\)\s*)?([\d,]+)/)), time: tm, mins };
    });
  }
  async function backToSearch() {
    const back = visible('button.ut-navigation-button-control')[0];
    if (back) { tap(back); await sl(1200); }
    if (!searchPage()) await openSearch();
  }
  async function watchRow(row) {
    row.li.scrollIntoView({ block: 'center' });
    tap(row.li.querySelector('.rowContent') || row.li); await sl(900);
    const w = visible('button').find((b) => { const t = b.innerText.replace(/\s+/g, ' ').trim(); return /(^|\s)Watch$/.test(t) && !/Unwatch/i.test(t); });
    if (!w) return false;
    tap(w); await sl(1200);
    if (/transfer targets (?:list )?is full|maximum number of/i.test(document.body.innerText)) throw new Error('targets full');
    return true;
  }

  async function scanCard(card) {
    const rec = { at: new Date().toISOString(), card: card.name, rating: card.rating, sheet_min: card.min, sheet_avg: card.avg, sheet_max: card.max, sheet_5d: card.d5, listings: 0, lowest_bn: null, lowest_bid: null, flags: [] };
    if (!(await pickPlayer(card))) { rec.flags.push('not found in search'); return { rec, stop: false }; }
    const hits = [];
    const judge = (rows, kind) => {
      for (const r of rows) {
        if (r.rating !== card.rating || !fold(r.text).includes(fold(card.name).split(' ').pop())) { rec.flags.push('skipped other version'); continue; }
        rec.listings += 1;
        if (r.bn) rec.lowest_bn = Math.min(rec.lowest_bn ?? Infinity, r.bn);
        const cur = r.bid || r.start; if (kind === 'auction' && cur) rec.lowest_bid = Math.min(rec.lowest_bid ?? Infinity, cur);
        if (r.bn && r.bn < card.min * 0.5) { rec.flags.push(`suspect price ${k$(r.bn)} skipped`); continue; }
        if (kind === 'bin' && r.bn && r.bn <= card.min) hits.push({ r, why: r.bn <= card.min * 0.95 ? 'BIN <=95%' : 'BIN <=min', alert: r.bn <= card.min * 0.95, price: r.bn });
        if (kind === 'auction' && cur && cur <= card.min) hits.push({ r, why: cur <= card.min * 0.95 && r.mins < 20 ? 'Auction <=95% <20m' : 'Auction <=min', alert: cur <= card.min * 0.95 && r.mins < 20, price: cur });
      }
    };
    judge(await runSearch(null, card.min), 'bin');
    for (const h of hits.filter((x) => !x.done)) { if (await watchRow(h.r)) { h.done = true; rec.flags.push(`watched ${h.why} ${k$(h.price)}`); } }
    if (CHECK_AUCTIONS) {
      await backToSearch(); await pickPlayer(card);
      const before = hits.length;
      judge(await runSearch(Math.floor(card.min * 0.95), null), 'auction');
      for (const h of hits.slice(before)) { if (await watchRow(h.r)) { h.done = true; rec.flags.push(`watched ${h.why} ${k$(h.price)}`); } }
    }
    rec.flags = [...new Set(rec.flags)];
    if (rec.lowest_bn === Infinity) rec.lowest_bn = null; if (rec.lowest_bid === Infinity) rec.lowest_bid = null;
    const alerts = hits.filter((h) => h.alert);
    if (alerts.length) {
      const text = alerts.map((h) => `${h.why}: ${k$(h.price)}${h.r.mins < 9999 ? ' (' + h.r.time + ')' : ''}`).join('\n') +
        `\nPC Min ${k$(card.min)} · Avg ${k$(card.avg)} · Max ${k$(card.max)} · 5-day min ${k$(card.d5)}`;
      GM_notification({ title: `Scan hit: ${card.name} ${card.rating} (added to Transfer Targets)`, text, timeout: 0 });
      log('SCAN HIT', card.name, card.rating, text);
    }
    await backToSearch();
    return { rec, stop: alerts.length > 0 };
  }

  async function heroIconScan(fromStart) {
    if (scanning) { log('scan already running'); return; }
    if (running) { log('a snapshot is running; try the scan again in a minute'); return; }
    if (capHit()) { GM_notification({ title: 'Scan not started', text: capHit() + '. Try again later.', timeout: 8000 }); return; }
    scanning = true; scanStop = false;
    const recs = [];
    try {
      const list = await loadPcList();
      let i = fromStart ? 0 : GM_getValue('scanIndex', 0); if (i >= list.length) i = 0;
      log(`scan: ${list.length} cards between ${k$(SCAN_MIN)} and ${k$(SCAN_MAX)}, starting at #${i + 1} ${list[i] && list[i].name}`);
      await openSearch();
      let done = 0, paused = false;
      while (i < list.length && done < CARDS_PER_RUN && !scanStop) {
        if (capHit()) { log(capHit()); break; }
        const { rec, stop } = await scanCard(list[i]);
        recs.push(rec); i += 1; done += 1; GM_setValue('scanIndex', i);
        if (stop) { paused = true; break; }
        await sl(rnd([4000, 8000]));
      }
      const hits = recs.filter((r) => r.flags.some((f) => f.startsWith('watched'))).length;
      GM_notification({ title: paused ? 'Scan paused on a hit' : 'Scan finished', text: `${recs.length} cards scanned, ${hits} added to Transfer Targets. Next: #${i + 1}${list[i] ? ' ' + list[i].name : ' (end of list)'}.`, timeout: 10000 });
    } catch (e) {
      const why = String(e);
      GM_notification({ title: 'Scan stopped', text: /blocked/.test(why) ? 'EA showed a login, verification or "too many" message. Stopped.' : why, timeout: 0 });
      log('scan stopped:', e);
    } finally {
      scanning = false;
      if (recs.length) { try { await send({ secret: cfg().secret, type: 'scan', at: new Date().toISOString(), scans: recs }); } catch (e) { log('could not save scan records', e); } }
    }
  }
  // ======================= Off-list price check (after each snapshot) =======================
  // For cards that have left the Transfer List, one search each with Buy Now max = 110% of the last Enhancer price,
  // then record how many listings came back and the lowest Buy Now. Read only: it never presses Watch or anything else.
  const OFF_SEARCH_MAX = 1.10;
  const step = (p) => (p < 1000 ? 50 : p < 10000 ? 100 : p < 50000 ? 250 : p < 100000 ? 500 : 1000);
  async function priceOffCard(card) {
    const rec = { at: new Date().toISOString(), player: card.player, rating: card.rating, left_list_at: card.left_list_at,
      last_enhancer: card.last_enhancer, search_max: null, listings: 0, lowest_bn: null, flags: [] };
    if (/\(Holo\)/.test(card.player)) { rec.flags.push('holo version cannot be told apart in search, skipped'); return rec; }
    if (!(await pickPlayer({ name: card.player, rating: card.rating }))) { rec.flags.push('not found in search'); return rec; }
    const s = step(card.last_enhancer * OFF_SEARCH_MAX);
    rec.search_max = Math.ceil(card.last_enhancer * OFF_SEARCH_MAX / s) * s;
    const res = await runSearch(null, rec.search_max);
    for (const r of res) {
      if (r.rating !== card.rating || !fold(r.text).includes(fold(card.player).split(' ').pop())) { rec.flags.push('skipped other version'); continue; }
      if (r.bn && r.bn < card.last_enhancer * 0.5) { rec.flags.push(`suspect price ${k$(r.bn)} skipped`); continue; }
      rec.listings += 1;
      if (r.bn) rec.lowest_bn = Math.min(rec.lowest_bn ?? Infinity, r.bn);
    }
    if (!rec.listings) rec.flags.push('no listings at or under search max');
    if (res.length >= 20) rec.flags.push('full results page, lowest is from the first page only');
    rec.flags = [...new Set(rec.flags)];
    await backToSearch();
    return rec;
  }
  async function offlistCheck(res) {
    let list = [];
    try { list = JSON.parse(res).offlist || []; } catch (e) { return; }
    if (!list.length || scanning) return;
    if (capHit()) { log('off-list check skipped:', capHit()); return; }
    scanning = true;
    const recs = [];
    try {
      await openSearch();
      for (const card of list) {
        if (capHit()) { log(capHit()); break; }
        if ((Date.now() - lastInput) / 60000 < 0.5) { log('you are back, off-list check stopped'); break; }
        recs.push(await priceOffCard(card));
        await sl(rnd([4000, 8000]));
      }
      log('off-list check:', recs.map((r) => `${r.player} ${r.rating} ${k$(r.lowest_bn)}`).join(', '));
    } catch (e) {
      if (/blocked/.test(String(e))) { stopped = true; GM_notification({ title: 'Collector stopped', text: 'EA showed a login, verification or "too many" message during the off-list check.', timeout: 0 }); }
      log('off-list check stopped:', e);
    } finally {
      scanning = false;
      if (recs.length) { try { await send({ secret: cfg().secret, type: 'offlist', offlist: recs }); } catch (e) { log('could not save off-list records', e); } }
    }
  }

  GM_registerMenuCommand('Hero/Icon scan: continue', () => heroIconScan(false));
  GM_registerMenuCommand('Hero/Icon scan: restart from cheapest', () => heroIconScan(true));
  GM_registerMenuCommand('Hero/Icon scan: stop after this card', () => { scanStop = true; log('scan will stop after the current card'); });

  let started = false;
  function start() {
    if (started) return; started = true;
    // Tampermonkey menu: run a snapshot right now (skips the idle wait; the timer restarts afterwards).
    GM_registerMenuCommand('Run snapshot now', () => { stopped = false; log('manual run'); tick(true); });
    schedule(2); // first run two minutes after the web app loads
  }
  GM_registerMenuCommand('Set web app URL and secret', () => {
    const url = prompt('Apps Script web app /exec URL', cfg().url);
    if (url == null) return;
    const secret = prompt('Secret (same as SECRET in Script Properties)', cfg().secret);
    if (secret == null) return;
    GM_setValue('webappUrl', url.trim()); GM_setValue('secret', secret.trim());
    log('web app URL and secret saved');
    if (cfg().url && cfg().secret) start();
  });

  if (!cfg().url || !cfg().secret) { log('Set the web app URL and secret from the Tampermonkey menu: "Set web app URL and secret".'); return; }
  start();
})();
