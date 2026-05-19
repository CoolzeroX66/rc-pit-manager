'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   STATE — v2 schema: one dashboard per class, backed by LocalStorage
   ════════════════════════════════════════════════════════════════════════════ */
const State = {
  data: null,

  load() {
    try {
      const raw = localStorage.getItem('gr66_state');
      this.data = raw ? JSON.parse(raw) : null;
    } catch (e) {
      this.data = null;
    }
    return this.data;
  },

  save() {
    try {
      localStorage.setItem('gr66_state', JSON.stringify(this.data));
    } catch (e) {
      console.error('LocalStorage save failed:', e);
    }
  },

  reset() {
    ['gr66_state', 'gr66_pdf_groups', 'gr66_pdf_schedule'].forEach(k => localStorage.removeItem(k));
    location.reload();
  },

  // Migrate v1 (single flat state) → v2 (dashboards array)
  migrate() {
    if (!this.data || this.data.version === 2) return;
    this.data = {
      version:              2,
      driverName:           this.data.driverName,
      dashboards: [{
        id:               'dash_0',
        driverClass:      this.data.driverClass || 'Unbekannt',
        driverGroup:      this.data.driverGroup || 'Gruppe ?',
        races:            this.data.races || [],
        currentRaceIndex: this.data.currentRaceIndex || 0,
        globalOffsetMs:   this.data.globalOffsetMs || 0
      }],
      activeDashboardIndex: 0,
      setupComplete:        this.data.setupComplete
    };
    this.save();
  },

  get activeDashboard() {
    if (!this.data || !this.data.dashboards) return null;
    return this.data.dashboards[this.data.activeDashboardIndex] || null;
  },

  setActiveDashboard(index) {
    if (!this.data) return;
    this.data.activeDashboardIndex = index;
    this.save();
  },

  setRaceStatus(index, status) {
    const dash = this.activeDashboard;
    if (!dash || !dash.races[index]) return;
    dash.races[index].status = status;
    this.save();
  },

  get currentRace() {
    const dash = this.activeDashboard;
    if (!dash) return null;
    return dash.races[dash.currentRaceIndex] || null;
  },

  effectiveStartMs(race) {
    const dash = this.activeDashboard;
    if (!race || !race.scheduledTimeISO || !dash) return null;
    return new Date(race.scheduledTimeISO).getTime()
      + (race.offsetMs || 0)
      + (dash.globalOffsetMs || 0);
  },

  applyOffset(deltaMs) {
    const dash = this.activeDashboard;
    if (!dash) return;
    dash.globalOffsetMs = (dash.globalOffsetMs || 0) + deltaMs;
    this.save();
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   SOUND ENGINE — Web Audio API beeps, no external files
   ════════════════════════════════════════════════════════════════════════════ */
const SoundEngine = {
  _ctx: null,

  _getCtx() {
    if (!this._ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) this._ctx = new Ctx();
    }
    return this._ctx;
  },

  unlock() {
    const ctx = this._getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  },

  _tone(ctx, freq, startTime, duration, gain) {
    const osc      = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, startTime);
    gainNode.gain.setValueAtTime(gain || 0.35, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  },

  beep(minutes) {
    const ctx = this._getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    if (minutes === 15) {
      for (let i = 0; i < 3; i++) {
        this._tone(ctx, 880, ctx.currentTime + i * 0.35, 0.2, 0.35);
      }
    } else {
      for (let i = 0; i < 5; i++) {
        this._tone(ctx, 1200, ctx.currentTime + i * 0.2, 0.15, 0.4);
      }
    }
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   MODAL CONTROLLER
   ════════════════════════════════════════════════════════════════════════════ */
const ModalController = {
  _queue:  [],
  _active: false,

  show(minutes, klasse) {
    if (this._active) {
      this._queue.push({ minutes, klasse });
      return;
    }
    this._active = true;

    const overlay    = document.getElementById('modal-overlay');
    const icon       = document.getElementById('modal-icon');
    const title      = document.getElementById('modal-title-text');
    const body       = document.getElementById('modal-body-text');
    const confirmBtn = document.getElementById('btn-modal-confirm');

    if (minutes === 15) {
      icon.textContent  = '🚗';
      title.textContent = klasse ? `15 Min – Haftmittel! (${klasse})` : '15 Minuten – Vorbereitung!';
      title.className   = 'modal-title warn-15';
      body.innerHTML    = '<strong>Haftmittel auf die Reifen auftragen!</strong><br><br>Stelle sicher, dass die Reifen gleichmäßig behandelt sind.';
    } else {
      icon.textContent  = '⚠️';
      title.textContent = klasse ? `5 Min – Abnahme! (${klasse})` : '5 Minuten – Abnahme!';
      title.className   = 'modal-title warn-5';
      body.innerHTML    = '<strong>Technische Abnahme steht an!</strong><br><br>Bitte Fahrzeug sofort zur Abnahme vorführen.';
    }

    overlay.classList.remove('hidden');
    confirmBtn.focus();
  },

  confirm() {
    document.getElementById('modal-overlay').classList.add('hidden');
    this._active = false;
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      this.show(next.minutes, next.klasse);
    }
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   PDF PARSER — ports Python text-fallback logic from Gozilla-Racing 2 Dev
   ════════════════════════════════════════════════════════════════════════════ */
const PDFParser = {
  HEADING_RE:               /(?<klasse>[^[\-]+?)\s*(?:\[[^\]]+\])?\s*[–\-|/]\s*(?<art>[^–\-|/]+?)\s*[–\-|/]\s*(?:(?<lauf_nr>\d+)\s*[–\-|/]\s*)?(?<gruppe>Gruppe\s+\S+)/i,
  FINALE_HEADING_RE:        /(?<art>[A-Z]-Finale)\s+(?<klasse>[^\n]+)/i,
  TEXT_DATA_ROW_RE:         /^\d+\.\s+(?:\d{1,6}\s+){0,3}(?<name>[A-ZÄÖÜ][^/\n]+?)(?=\s+(?:[A-Z]{3}\b|\d+\/\d)|$)/u,
  ZEITPLAN_FINALE_ROW_RE:   /^(?<zeit>\d{1,2}:\d{2})\s+(?:\d{1,2}:\d{2}\s+)?(?<nr>\d+)\.\s+(?<art>[A-Z]-Finale)\s+(?<klasse>\S.*)/i,
  FINALE_NAME_RE:           /(?<!\d)(?<lastname>[A-ZÄÖÜ][a-zA-ZäöüÄÖÜß\-]{1,25}),\s*(?<firstname>[A-ZÄÖÜ][a-zA-ZäöüÄÖÜß\-]{1,20}(?:\s+[A-ZÄÖÜ][a-zäöüß]{2,20})?)/u,
  SKIP_RE:                  /^(#|nr|pos|name|fahrer|teilnehmer|startposition|start\s*nr|platz|\s*)$/i,
  COL_HEADER_RE:            /^(nr|liz|zusatz|name|nat|club|tx|freq|temp|p\s+klasse|klasse)/i,
  ZEITPLAN_TABLE_HEADER_RE: /startzeit/i,

  async extractText(file) {
    if (!window.pdfjsLib) return null;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const pageTexts = [];

      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc   = await page.getTextContent();

        const items = [];
        for (const item of tc.items) {
          const s = item.str;
          if (!s || !s.trim()) continue;
          items.push({ str: s.trim(), x: item.transform[4], y: item.transform[5] });
        }

        if (!items.length) { pageTexts.push(''); continue; }

        // Sort top-to-bottom (PDF y=0 is bottom → DESC = top first), then left-to-right
        items.sort((a, b) => b.y - a.y || a.x - b.x);

        // Group into lines: items within 5pt vertically are on the same line
        const YTOL = 5;
        const lineGroups = [];
        let group = [items[0]];

        for (let i = 1; i < items.length; i++) {
          const item   = items[i];
          const groupY = group[0].y;
          if (Math.abs(item.y - groupY) <= YTOL) {
            group.push(item);
          } else {
            group.sort((a, b) => a.x - b.x);
            lineGroups.push(group.map(it => it.str).join(' '));
            group = [item];
          }
        }
        group.sort((a, b) => a.x - b.x);
        lineGroups.push(group.map(it => it.str).join(' '));

        console.debug(`[PDFParser] Seite ${p} — ${lineGroups.length} Zeilen extrahiert`);
        pageTexts.push(lineGroups.join('\n'));
      }
      return pageTexts;
    } catch (e) {
      console.error('[PDFParser] Fehler bei der Textextraktion:', e);
      return null;
    }
  },

  _parseHeading(text) {
    let m = this.HEADING_RE.exec(text);
    if (m) {
      const klasse = m.groups.klasse.trim();
      let art = m.groups.art.trim();
      if (m.groups.lauf_nr) art = `${art} ${m.groups.lauf_nr}`;
      return { klasse, art, gruppe: m.groups.gruppe.trim() };
    }
    m = this.FINALE_HEADING_RE.exec(text);
    if (m) {
      const art    = m.groups.art.trim();
      const klasse = m.groups.klasse.trim();
      return { klasse, art, gruppe: `Gruppe ${art[0].toUpperCase()}` };
    }
    return null;
  },

  _extractFinaleNameFromLine(line) {
    if (!/^\d+\s/.test(line)) return null;
    const m = this.FINALE_NAME_RE.exec(line);
    if (!m) return null;
    return `${m.groups.lastname}, ${m.groups.firstname}`;
  },

  parseGruppeneinteilung(pageTexts) {
    const groups = [];
    let current  = null;
    let isFinale = false;

    for (const pageText of pageTexts) {
      for (const rawLine of pageText.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        const heading = this._parseHeading(line);
        if (heading) {
          if (current && current.drivers.length) groups.push(current);
          current  = { klasse: heading.klasse, art: heading.art, gruppe: heading.gruppe, drivers: [] };
          isFinale = /finale/i.test(heading.art);
          continue;
        }

        if (!current) continue;
        if (this.COL_HEADER_RE.test(line)) continue;

        if (isFinale) {
          const name = this._extractFinaleNameFromLine(line);
          if (name) current.drivers.push(name);
        } else {
          const m = this.TEXT_DATA_ROW_RE.exec(line);
          if (m) {
            const name = m.groups.name.trim();
            if (name && !this.SKIP_RE.test(name)) current.drivers.push(name);
          }
        }
      }
    }
    if (current && current.drivers.length) groups.push(current);
    return groups;
  },

  parseZeitplan(pageTexts) {
    const schedule = [];
    const seen     = new Set();

    const addEntry = (klasse, gruppe, art, zeit) => {
      klasse = (klasse || '').trim().replace(/\s+/g, ' ');
      gruppe = (gruppe || '').trim();
      art    = (art    || '').trim();
      if (!klasse || !zeit) return;
      const key = `${klasse.toLowerCase()}|${gruppe.toLowerCase()}|${art.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      schedule.push({ klasse, gruppe, art, startzeit_hhmm: zeit });
      console.debug(`[Zeitplan] +Eintrag: ${zeit}  "${klasse}"  "${gruppe}"  "${art}"`);
    };

    // RC Race-Control format (Zeitplan-4 style):
    // Columns: KLASSE [Bracket]  GRUPPE  LAUF  Renndauer  Startzeit  Endzeit  Streckenposten
    // Qualifikation row: "Funcup [PW Cup Funcup] Gruppe 1 Qualifikation 1 00:05 09:00 09:05 ..."
    // Finale row:        "Touring [PW Cup Touring] Finale C Finallauf 1 00:05 13:30 13:35 ..."
    const RC_QUALI_RE  = /^(?<klasse>[^[\r\n]+?)\s+(?:\[[^\]]*\]\s+)?(?<gruppe>Gruppe\s+\d+)\s+Qualifikation\s+(?<nr>\d+)\s+\d{2}:\d{2}\s+(?<zeit>\d{1,2}:\d{2})/i;
    const RC_FINALE_RE = /^(?<klasse>[^[\r\n]+?)\s+(?:\[[^\]]*\]\s+)?(?<tier>Finale\s+[A-Z])\s+Finallauf\s+(?<nr>\d+)\s+\d{2}:\d{2}\s+(?<zeit>\d{1,2}:\d{2})/i;

    // Legacy / other formats (time-first lines)
    const extractGruppe = str => { const m = /(Gruppe\s+\S+)/i.exec(str); return m ? m[1].trim() : null; };
    const removeGruppe  = str => str.replace(/(Gruppe\s+\S+)/ig, '').replace(/\s{2,}/g, ' ').trim();

    for (const pageText of pageTexts) {
      console.debug('[Zeitplan] Rohtext (erste 2000 Zeichen):\n' + pageText.slice(0, 2000));

      for (const rawLine of pageText.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        // ── RC Race-Control: Qualifikation ───────────────────────────────────
        const qualiM = RC_QUALI_RE.exec(line);
        if (qualiM) {
          addEntry(qualiM.groups.klasse, qualiM.groups.gruppe,
                   `Qualifikation ${qualiM.groups.nr}`, qualiM.groups.zeit);
          continue;
        }

        // ── RC Race-Control: Finale (Finale A/B/C + Finallauf N) ─────────────
        const finaleM = RC_FINALE_RE.exec(line);
        if (finaleM) {
          // gruppe stores the finale tier ("Finale A"), art stores the run ("Finallauf 1")
          addEntry(finaleM.groups.klasse, finaleM.groups.tier,
                   `Finallauf ${finaleM.groups.nr}`, finaleM.groups.zeit);
          continue;
        }

        // ── Legacy: line starts with HH:MM ───────────────────────────────────
        const tm = /^(\d{1,2}:\d{2})(?::\d{2})?/.exec(line);
        if (!tm) continue;
        const zeit = tm[1];
        let rest   = line.slice(tm[0].length).trim().replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, '');

        // Legacy A: X-Finale (optional run-number prefix "1. ", "2. ", "3. ")
        const legFinM = /^(?:(\d+)\.?\s+)?([A-Z])-Finale\s*(.*)/i.exec(rest);
        if (legFinM) {
          const runNr  = legFinM[1] || null;
          const letter = legFinM[2].toUpperCase();
          let klasse   = legFinM[3].replace(/\s+\d{1,2}:\d{2}\s*$/, '').trim();
          const gruppe = extractGruppe(klasse) || `Gruppe ${letter}`;
          klasse       = removeGruppe(klasse) || klasse;
          addEntry(klasse, gruppe, runNr ? `${letter}-Finale ${runNr}` : `${letter}-Finale`, zeit);
          continue;
        }

        // Legacy B: "N. Qualifikation/Vorlauf Klasse [Gruppe]"
        const legQualiM = /^(\d+)\.?\s+(Qualifikation|Vorlauf|Training)\s+(.*)/i.exec(rest);
        if (legQualiM) {
          const rem    = legQualiM[3].trim();
          const gruppe = extractGruppe(rem) || 'Gruppe ?';
          const klasse = removeGruppe(rem);
          addEntry(klasse, gruppe, `${legQualiM[2]} ${legQualiM[1]}`, zeit);
          continue;
        }

        // Legacy C: Gruppe keyword present
        const gruppeC = extractGruppe(rest);
        if (gruppeC) {
          const noGru   = removeGruppe(rest);
          const artEndM = /(\d+)\.?\s+(Qualifikation|Vorlauf|Training|[A-Z]-Finale)\s*$/i.exec(noGru);
          if (artEndM) {
            const klasse = noGru.slice(0, artEndM.index).trim();
            const art    = /Finale/i.test(artEndM[2]) ? artEndM[2] : `${artEndM[2]} ${artEndM[1]}`;
            addEntry(klasse, gruppeC, art, zeit);
          } else {
            const klasse = noGru.replace(/\s*\d+\.?\s*$/, '').trim();
            if (klasse) addEntry(klasse, gruppeC, 'Qualifikation', zeit);
          }
        }
      }
    }

    console.debug('[Zeitplan] Ergebnis:', schedule.length, 'Einträge:', schedule);
    return schedule;
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   DASHBOARD RENDERER — all DOM writes isolated here
   ════════════════════════════════════════════════════════════════════════════ */
const DashboardRenderer = {
  renderAll() {
    this.renderDriverHeader();
    this.renderClassPanels();
  },

  renderDriverHeader() {
    const d = State.data;
    if (!d) return;
    document.getElementById('dash-driver-name').textContent = d.driverName || '—';
  },

  _soonestDashIdx() {
    const d = State.data;
    if (!d) return -1;
    let idx = -1, best = Infinity;
    d.dashboards.forEach((dash, i) => {
      if (dash.races.every(r => r.status === 'done')) return;
      const race = dash.races[dash.currentRaceIndex];
      if (!race || !race.scheduledTimeISO) return;
      const ms = new Date(race.scheduledTimeISO).getTime() + (dash.globalOffsetMs || 0);
      if (ms < best) { best = ms; idx = i; }
    });
    return idx;
  },

  renderClassPanels() {
    const d = State.data;
    if (!d || !d.dashboards) return;
    const container = document.getElementById('class-panels');
    container.innerHTML = '';
    container.className = d.dashboards.length > 1 ? 'class-panels multi' : 'class-panels';
    const soonestIdx = this._soonestDashIdx();
    d.dashboards.forEach((dash, i) => {
      container.appendChild(this._buildPanel(d, dash, i, i === soonestIdx));
    });
  },

  renderPanel(dashIdx) {
    const d = State.data;
    if (!d || !d.dashboards[dashIdx]) return;
    const old = document.getElementById(`cp-${dashIdx}`);
    if (!old) { this.renderClassPanels(); return; }
    const wasCollapsed = old.querySelector('.race-list')?.classList.contains('collapsed') ?? null;
    const soonestIdx = this._soonestDashIdx();
    const newPanel = this._buildPanel(d, d.dashboards[dashIdx], dashIdx, dashIdx === soonestIdx);
    if (wasCollapsed !== null) {
      const rl = newPanel.querySelector('.race-list');
      if (rl) {
        if (wasCollapsed) rl.classList.add('collapsed');
        else rl.classList.remove('collapsed');
        const chevron = rl.querySelector('.race-list-chevron');
        if (chevron) chevron.textContent = wasCollapsed ? '▶' : '▼';
      }
    }
    old.replaceWith(newPanel);
  },

  _buildPanel(d, dash, idx, isNext) {
    const allDone  = dash.races.every(r => r.status === 'done');
    const race     = dash.races[dash.currentRaceIndex];
    const isFinale = race && race.type === 'Finale';

    const panel = document.createElement('div');
    panel.id        = `cp-${idx}`;
    panel.className = `class-panel${isNext && !allDone ? ' is-next' : ''}${allDone ? ' is-done' : ''}`;

    // ── Header
    const hdr = document.createElement('div');
    hdr.className = 'class-panel-header';
    hdr.innerHTML = `
      <div class="class-panel-info">
        <span class="class-panel-name">${dash.driverClass}</span>
        <span class="class-panel-group">${dash.driverGroup}</span>
      </div>
      <div class="cp-dots">${this._buildDots(dash)}</div>`;
    panel.appendChild(hdr);

    // ── Race card
    const card = document.createElement('div');
    card.className = `class-panel-race${isFinale ? ' finale' : ''}`;

    let timeStr = 'Zeit TBD';
    let timeTbd = true;
    if (race && race.scheduledTimeISO) {
      const ms = new Date(race.scheduledTimeISO).getTime()
                 + (race.offsetMs || 0)
                 + (dash.globalOffsetMs || 0);
      const dt = new Date(ms);
      timeStr  = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')} Uhr`;
      timeTbd  = false;
    }

    card.innerHTML = `
      <div class="cp-race-meta">
        <span class="badge ${isFinale ? 'badge-final-type' : 'badge-vorlauf-type'}">${race ? race.type : '—'}</span>
        <span class="cp-race-label">${race ? race.label : '—'}</span>
        <span class="badge badge-gruppe">${race ? (race.group || dash.driverGroup) : '—'}</span>
      </div>
      <div class="cp-time-row">
        <div class="cp-time-block">
          <div class="cp-label">Startzeit</div>
          <div class="cp-time-value${timeTbd ? ' scheduled-time-tbd' : ''}" id="cp-time-${idx}">${timeStr}</div>
        </div>
        <div class="cp-cd-block">
          <div class="cp-label">Countdown</div>
          <div class="countdown-value countdown-far" id="cp-cd-${idx}">--:--</div>
        </div>
      </div>
      <div class="status-msg hidden" id="cp-status-${idx}"></div>`;
    panel.appendChild(card);

    // ── Adjust controls
    const adj = document.createElement('div');
    adj.className = 'cp-adjust';
    const oMin = Math.round((dash.globalOffsetMs || 0) / 60000);
    const oTxt = oMin === 0 ? 'Kein Versatz' : `${oMin > 0 ? '+' : ''}${oMin} Min`;
    adj.innerHTML = `
      <div class="cp-adjust-btns">
        <button class="btn-adjust-panel" data-dash="${idx}" data-delta="-300">−5'</button>
        <button class="btn-adjust-panel" data-dash="${idx}" data-delta="-60">−1'</button>
        <button class="btn-adjust-panel" data-dash="${idx}" data-delta="60">+1'</button>
        <button class="btn-adjust-panel" data-dash="${idx}" data-delta="300">+5'</button>
      </div>
      <div class="offset-display${oMin !== 0 ? ' nonzero' : ''}" id="cp-off-${idx}">${oTxt}</div>`;
    panel.appendChild(adj);

    // ── Race list (collapsed by default in multi-panel mode)
    const isMulti = d.dashboards.length > 1;
    const list = document.createElement('div');
    list.className = `race-list${isMulti ? ' collapsed' : ''}`;
    list.innerHTML = `<div class="race-list-header race-list-toggle">
      <span>Alle Läufe</span>
      <span class="race-list-chevron">${isMulti ? '▶' : '▼'}</span>
    </div>`;
    dash.races.forEach((r, i) => {
      const isCur  = i === dash.currentRaceIndex;
      const isDone = r.status === 'done';
      const isFin  = r.type === 'Finale';
      let ts = '--:--';
      if (r.scheduledTimeISO) {
        const ms = new Date(r.scheduledTimeISO).getTime() + (r.offsetMs || 0) + (dash.globalOffsetMs || 0);
        const dt = new Date(ms);
        ts = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
      }
      let dotCls = isFin ? 'finale' : 'vorlauf';
      if (isDone) dotCls += ' done';
      if (isCur)  dotCls += ' current';
      const row = document.createElement('div');
      row.className = `race-list-row${isCur ? ' current' : ''}${isDone ? ' done' : ''}`;
      row.innerHTML = `
        <div class="race-list-dot ${dotCls}"></div>
        <div class="race-list-label">${r.label}</div>
        <div class="race-list-time">${ts}</div>
        <div class="race-list-status">${isCur ? '▶' : isDone ? '✓' : ''}</div>`;
      list.appendChild(row);
    });
    panel.appendChild(list);

    return panel;
  },

  _buildDots(dash) {
    return dash.races.map((r, i) => {
      const pre = i === 3 ? '<span class="cp-dot-sep"></span>' : '';
      let cls = `cp-dot ${i < 3 ? 'vl' : 'fi'}`;
      if (r.status === 'done')              cls += ' done';
      else if (i === dash.currentRaceIndex) cls += ' active';
      return `${pre}<span class="${cls}" title="${r.label}"></span>`;
    }).join('');
  },

  updatePanelCountdown(dashIdx, diffS, race) {
    const el     = document.getElementById(`cp-cd-${dashIdx}`);
    const status = document.getElementById(`cp-status-${dashIdx}`);
    if (!el || !race) return;

    if (race.status === 'running') {
      const e = Math.abs(diffS || 0);
      el.textContent = `${String(Math.floor(e / 60)).padStart(2,'0')}:${String(e % 60).padStart(2,'0')}`;
      el.className   = 'countdown-value countdown-running';
      if (status) { status.textContent = '🚦 Lauf läuft…'; status.className = 'status-msg running'; status.classList.remove('hidden'); }
      return;
    }

    if (race.status === 'done') {
      el.textContent = '✓';
      el.className   = 'countdown-value countdown-done';
      if (status) { status.textContent = '✓ Abgeschlossen'; status.className = 'status-msg done'; status.classList.remove('hidden'); }
      return;
    }

    if (status) status.classList.add('hidden');

    if (diffS == null) { el.textContent = '--:--'; el.className = 'countdown-value countdown-far'; return; }
    if (diffS <= 0)    { el.textContent = '00:00'; el.className = 'countdown-value countdown-running'; return; }

    el.textContent = `${String(Math.floor(diffS / 60)).padStart(2,'0')}:${String(diffS % 60).padStart(2,'0')}`;
    if      (diffS <= 300) el.className = 'countdown-value countdown-urgent';
    else if (diffS <= 900) el.className = 'countdown-value countdown-soon';
    else                   el.className = 'countdown-value countdown-far';
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   COUNTDOWN CONTROLLER — rAF-based state machine
   ════════════════════════════════════════════════════════════════════════════ */
const CountdownController = {
  _rafId:      null,
  _lastSecond: -1,

  start() {
    this._lastSecond = -1;
    this._rafLoop();
  },

  stop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  },

  _rafLoop() {
    this._rafId = requestAnimationFrame(() => {
      const nowS = Math.floor(Date.now() / 1000);
      if (nowS !== this._lastSecond) {
        this._lastSecond = nowS;
        this._tick(nowS);
      }
      this._rafLoop();
    });
  },

  _tick(nowS) {
    if (!State.data || !State.data.dashboards) return;
    State.data.dashboards.forEach((dash, i) => {
      const race = dash.races[dash.currentRaceIndex];
      if (!race || !race.scheduledTimeISO) {
        DashboardRenderer.updatePanelCountdown(i, null, race);
        return;
      }
      const startMs = new Date(race.scheduledTimeISO).getTime()
                      + (race.offsetMs || 0)
                      + (dash.globalOffsetMs || 0);
      const diffS = Math.floor((startMs - Date.now()) / 1000);
      this._checkTransitionsForDash(i, diffS, race, dash);
      DashboardRenderer.updatePanelCountdown(i, diffS, race);
    });
  },

  _checkTransitionsForDash(dashIdx, diffS, race, dash) {
    const idx = dash.currentRaceIndex;

    if (diffS <= 900 && diffS > 840 && race.status === 'pending') {
      dash.races[idx].status = 'warning_15';
      State.save();
      SoundEngine.beep(15);
      ModalController.show(15, dash.driverClass);
      return;
    }

    if (diffS <= 300 && diffS > 240 && race.status === 'warning_15') {
      dash.races[idx].status = 'warning_5';
      State.save();
      SoundEngine.beep(5);
      ModalController.show(5, dash.driverClass);
      return;
    }

    if (diffS <= 0 && (race.status === 'warning_5' || race.status === 'warning_15' || race.status === 'pending')) {
      dash.races[idx].status = 'running';
      State.save();
      DashboardRenderer.renderPanel(dashIdx);
      return;
    }

    if (diffS <= -300 && race.status === 'running') {
      this._advanceRaceInDash(dashIdx, dash);
    }
  },

  _advanceRaceInDash(dashIdx, dash) {
    dash.races[dash.currentRaceIndex].status = 'done';
    const nextIndex = dash.currentRaceIndex + 1;

    if (nextIndex < dash.races.length) {
      dash.currentRaceIndex = nextIndex;
      State.save();
      DashboardRenderer.renderPanel(dashIdx);
      return;
    }

    State.save();
    const allDone = State.data.dashboards.every(d => d.races.every(r => r.status === 'done'));
    if (allDone) {
      App.showView('summary');
      SummaryRenderer.render();
    } else {
      DashboardRenderer.renderPanel(dashIdx);
    }
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   SETUP CONTROLLER
   ════════════════════════════════════════════════════════════════════════════ */
const SetupController = {
  _groups:   null,
  _schedule: null,

  init() {
    try {
      const raw1 = localStorage.getItem('gr66_pdf_groups');
      const raw2 = localStorage.getItem('gr66_pdf_schedule');
      if (raw1) this._groups   = JSON.parse(raw1);
      if (raw2) this._schedule = JSON.parse(raw2);
    } catch (e) { /* ignore */ }

    if (this._groups && this._groups.length) {
      document.getElementById('btn-weiter-fahrer').classList.remove('hidden');
      this._showDriverStep();
    }

    document.getElementById('btn-weiter-fahrer').addEventListener('click', () => {
      SoundEngine.unlock();
      this._showDriverStep();
    });

    document.getElementById('input-gruppen').addEventListener('change', e => {
      if (e.target.files[0]) this._handleGruppenFile(e.target.files[0]);
    });
    document.getElementById('input-zeitplan').addEventListener('change', e => {
      if (e.target.files[0]) this._handleZeitplanFile(e.target.files[0]);
    });

    document.getElementById('select-driver').addEventListener('change', e => {
      this._previewDriver(e.target.value);
    });
    document.getElementById('btn-open-dashboard').addEventListener('click', () => {
      this._confirmDriver();
    });
    document.getElementById('btn-back-step1').addEventListener('click', () => {
      document.getElementById('step-driver').classList.add('hidden');
      document.getElementById('step-upload').classList.remove('hidden');
    });

    document.getElementById('btn-demo').addEventListener('click', () => {
      SoundEngine.unlock();
      this._startDemo();
    });
  },

  async _handleGruppenFile(file) {
    this._setFileLabel('fname-gruppen', file.name, true);
    const statusEl = document.getElementById('status-gruppen');
    this._setStatus(statusEl, 'loading', '⏳ Parsing…');

    const pageTexts = await PDFParser.extractText(file);
    if (!pageTexts) {
      this._setStatus(statusEl, 'error', '❌ PDF konnte nicht gelesen werden. Bitte Demo-Modus nutzen.');
      return;
    }

    const groups = PDFParser.parseGruppeneinteilung(pageTexts);
    if (!groups.length) {
      this._setStatus(statusEl, 'error', '❌ Keine Gruppen erkannt. Format ggf. nicht unterstützt.');
      return;
    }

    this._groups = groups;
    localStorage.setItem('gr66_pdf_groups', JSON.stringify(groups));

    const totalDrivers = groups.reduce((s, g) => s + g.drivers.length, 0);
    this._setStatus(statusEl, 'success', `✓ ${groups.length} Gruppen, ${totalDrivers} Fahrer erkannt`);
    document.getElementById('btn-weiter-fahrer').classList.remove('hidden');
    this._showDriverStep();
  },

  async _handleZeitplanFile(file) {
    this._setFileLabel('fname-zeitplan', file.name, true);
    const statusEl = document.getElementById('status-zeitplan');
    this._setStatus(statusEl, 'loading', '⏳ Parsing…');

    const pageTexts = await PDFParser.extractText(file);
    if (!pageTexts) {
      this._setStatus(statusEl, 'error', '❌ PDF konnte nicht gelesen werden.');
      return;
    }

    const schedule = PDFParser.parseZeitplan(pageTexts);
    if (!schedule.length) {
      this._setStatus(statusEl, 'error', '❌ Keine Startzeiten erkannt.');
      return;
    }

    this._schedule = schedule;
    localStorage.setItem('gr66_pdf_schedule', JSON.stringify(schedule));
    this._setStatus(statusEl, 'success', `✓ ${schedule.length} Startzeiten erkannt`);
    this._renderZeitplanPreview(schedule);
    if (this._groups && this._groups.length) {
      document.getElementById('btn-weiter-fahrer').classList.remove('hidden');
    }
  },

  _renderZeitplanPreview(schedule) {
    const wrap = document.getElementById('zeitplan-preview-wrap');
    const body = document.getElementById('zeitplan-preview-body');
    body.innerHTML = '';
    schedule.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="zeit-cell">${row.startzeit_hhmm}</td>
        <td>${row.klasse}</td>
        <td>${row.gruppe}</td>
        <td>${row.art}</td>
      `;
      body.appendChild(tr);
    });
    wrap.classList.remove('hidden');
  },

  _showDriverStep() {
    if (!this._groups) return;
    const sel = document.getElementById('select-driver');
    sel.innerHTML = '<option value="">— Fahrer wählen —</option>';

    const seen       = new Set();
    const allDrivers = [];
    for (const g of this._groups) {
      for (const d of g.drivers) {
        const key = d.toLowerCase().trim();
        if (!seen.has(key)) {
          seen.add(key);
          allDrivers.push(d);
        }
      }
    }
    allDrivers.sort((a, b) => a.localeCompare(b, 'de'));
    allDrivers.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });

    document.getElementById('step-upload').classList.add('hidden');
    document.getElementById('step-driver').classList.remove('hidden');
  },

  // Returns all unique classes a driver competes in (deduped by klasse)
  _findAllDriverGroups(name) {
    if (!this._groups) return [];
    const needle = name.toLowerCase().trim();
    const seen   = new Set();
    const result = [];
    for (const g of this._groups) {
      for (const d of g.drivers) {
        if (d.toLowerCase().trim() === needle) {
          const key = g.klasse.toLowerCase().trim();
          if (!seen.has(key)) {
            seen.add(key);
            result.push({ klasse: g.klasse, gruppe: g.gruppe, art: g.art });
          }
        }
      }
    }
    return result;
  },

  _previewDriver(name) {
    const previewEl = document.getElementById('driver-preview');
    const textEl    = document.getElementById('driver-preview-text');
    const btn       = document.getElementById('btn-open-dashboard');

    if (!name) {
      previewEl.classList.add('hidden');
      btn.disabled = true;
      return;
    }

    const allGroups = this._findAllDriverGroups(name);
    if (allGroups.length > 0) {
      textEl.innerHTML = allGroups
        .map(g => `Klasse: <strong>${g.klasse}</strong> &nbsp;|&nbsp; Gruppe: <strong>${g.gruppe}</strong>`)
        .join('<br>');
      previewEl.classList.remove('hidden');
    } else {
      textEl.textContent = 'Klasse/Gruppe nicht erkannt';
      previewEl.classList.remove('hidden');
    }
    btn.disabled = false;
  },

  _confirmDriver() {
    SoundEngine.unlock();
    const name = document.getElementById('select-driver').value;
    if (!name) return;

    let allGroups = this._findAllDriverGroups(name);
    if (!allGroups.length) allGroups = [{ klasse: 'Unbekannt', gruppe: 'Gruppe ?' }];

    const dashboards = allGroups.map((g, i) => ({
      id:               `dash_${i}`,
      driverClass:      g.klasse,
      driverGroup:      g.gruppe,
      races:            this._buildRaceArray(name, g.klasse, g.gruppe, this._groups, this._schedule || []),
      currentRaceIndex: 0,
      globalOffsetMs:   0
    }));

    State.data = {
      version:              2,
      driverName:           name,
      dashboards,
      activeDashboardIndex: 0,
      setupComplete:        true
    };
    State.save();
    App.launchDashboard();
  },

  _buildRaceArray(driverName, klasse, gruppe, groups, schedule) {
    const today   = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

    const raceSlots = [
      { type: 'Vorlauf', number: 1, label: 'Vorlauf 1', artKeywords: ['qualifikation', 'vorlauf', 'vl1', 'vl 1', '1'] },
      { type: 'Vorlauf', number: 2, label: 'Vorlauf 2', artKeywords: ['qualifikation', 'vorlauf', 'vl2', 'vl 2', '2'] },
      { type: 'Vorlauf', number: 3, label: 'Vorlauf 3', artKeywords: ['qualifikation', 'vorlauf', 'vl3', 'vl 3', '3'] },
      { type: 'Finale',  number: 1, label: 'Finale 1',  artKeywords: ['a-finale', 'finale 1', 'final 1'] },
      { type: 'Finale',  number: 2, label: 'Finale 2',  artKeywords: ['b-finale', 'finale 2', 'final 2'] },
      { type: 'Finale',  number: 3, label: 'Finale 3',  artKeywords: ['c-finale', 'finale 3', 'final 3'] },
    ];

    // Collect all Gruppe strings this driver appears in (for schedule matching)
    const driverGroups = [];
    if (groups) {
      for (const g of groups) {
        for (const d of g.drivers) {
          if (d.toLowerCase().trim() === driverName.toLowerCase().trim()) {
            driverGroups.push({ klasse: g.klasse, gruppe: g.gruppe, art: g.art });
          }
        }
      }
    }

    // Detect driver's finale tier from Gruppeneinteilung (e.g. "Finale A" → tier='A')
    const finaleEntry = driverGroups.find(dg =>
      (dg.klasse.toLowerCase().includes(klasse.toLowerCase().substring(0, 4)) ||
       klasse.toLowerCase().includes(dg.klasse.toLowerCase().substring(0, 4))) &&
      /finale/i.test(dg.art)
    );
    const finaleTier = finaleEntry
      ? (finaleEntry.art.match(/^([A-C])-Finale/i)?.[1]?.toUpperCase()
         || finaleEntry.art.match(/Finale\s+([A-C])/i)?.[1]?.toUpperCase()
         || null)
      : null;
    console.debug(`[BuildRace] ${klasse} | gruppe=${gruppe} | finaleTier=${finaleTier}`);

    return raceSlots.map((slot, i) => {
      let matchedTime = null;

      if (schedule && schedule.length) {
        for (const entry of schedule) {
          const entryArtLower    = entry.art.toLowerCase();
          const entryKlasseLower = entry.klasse.toLowerCase();
          const entryGruppeLower = (entry.gruppe || '').toLowerCase();
          const klasseLower      = klasse.toLowerCase();

          const klassesMatch = entryKlasseLower.includes(klasseLower.substring(0, 4)) ||
                               klasseLower.includes(entryKlasseLower.substring(0, 4));
          if (!klassesMatch) continue;

          if (slot.type === 'Finale') {
            // RC Race-Control format: gruppe="Finale A/B/C", art="Finallauf N"
            if (/^finale\s+[a-c]/i.test(entryGruppeLower) && /finallauf/i.test(entryArtLower)) {
              if (finaleTier && !entryGruppeLower.includes(`finale ${finaleTier.toLowerCase()}`)) continue;
              const artNr = entryArtLower.match(/\d+/);
              if (artNr && parseInt(artNr[0]) === slot.number) {
                matchedTime = entry.startzeit_hhmm;
                break;
              }
              continue;
            }
            // Legacy format with run number: "A-Finale 1", "A-Finale 2", …
            if (finaleTier) {
              const tierLetter = finaleTier.toLowerCase();
              if (entryArtLower.startsWith(`${tierLetter}-finale`)) {
                const runNrM = entryArtLower.match(/(\d+)$/);
                if (runNrM && parseInt(runNrM[1]) === slot.number) {
                  matchedTime = entry.startzeit_hhmm;
                  break;
                }
              }
            }
            // Fallback: artKeywords (old format without run number, or finaleTier unknown)
            if (!matchedTime && slot.artKeywords.some(kw => entryArtLower.includes(kw))) {
              matchedTime = entry.startzeit_hhmm;
            }
          } else {
            // Vorlauf / Qualifikation
            const gruppeLower   = gruppe.toLowerCase();
            const gruppeMatches = entryGruppeLower === gruppeLower ||
                                  driverGroups.some(dg => dg.gruppe.toLowerCase() === entryGruppeLower);
            if (!gruppeMatches) continue;

            const artNum = entryArtLower.match(/\d+/);
            if (artNum && parseInt(artNum[0]) === slot.number) {
              matchedTime = entry.startzeit_hhmm;
              break;
            }
            if (/qualifikation|vorlauf/.test(entryArtLower) && !matchedTime) {
              matchedTime = entry.startzeit_hhmm;
            }
          }
        }
      }

      return {
        id:               `race_${i}`,
        type:             slot.type,
        number:           slot.number,
        label:            slot.label,
        group:            gruppe,
        klasse,
        scheduledTimeISO: matchedTime ? `${dateStr}T${matchedTime}:00` : null,
        offsetMs:         0,
        status:           'pending'
      };
    });
  },

  _startDemo() {
    const now  = Date.now();
    const pad  = n => String(n).padStart(2, '0');
    const toISO = ms => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const gap    = 20 * 60 * 1000;
    const labels = ['Vorlauf 1','Vorlauf 2','Vorlauf 3','Finale 1','Finale 2','Finale 3'];
    const types  = ['Vorlauf','Vorlauf','Vorlauf','Finale','Finale','Finale'];

    const makeDashboard = (id, klasse, gruppe, startOffset) => ({
      id,
      driverClass:      klasse,
      driverGroup:      gruppe,
      races: labels.map((label, i) => ({
        id:               `${id}_race_${i}`,
        type:             types[i],
        number:           (i % 3) + 1,
        label,
        group:            gruppe,
        klasse,
        scheduledTimeISO: toISO(now + startOffset + (i + 1) * gap),
        offsetMs:         0,
        status:           'pending'
      })),
      currentRaceIndex: 0,
      globalOffsetMs:   0
    });

    State.data = {
      version:              2,
      driverName:           'Demo Fahrer',
      dashboards: [
        makeDashboard('dash_0', 'Touring',  'Gruppe A', 0),
        makeDashboard('dash_1', 'Fun-Cup',  'Gruppe B', 10 * 60 * 1000)
      ],
      activeDashboardIndex: 0,
      setupComplete:        true
    };
    State.save();
    App.launchDashboard();
  },

  _setFileLabel(id, name, selected) {
    const el = document.getElementById(id);
    el.textContent = name;
    el.classList.toggle('selected', selected);
    const wrapper = el.closest('.file-input-custom');
    if (wrapper) wrapper.classList.toggle('has-file', selected);
  },

  _setStatus(el, type, msg) {
    el.className   = `parse-status ${type}`;
    el.textContent = msg;
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   ANALYSE PARSER
   ════════════════════════════════════════════════════════════════════════════ */
const AnalyseParser = {
  STORE_KEY: 'gr66_analyse',

  async parse(file) {
    const pageTexts = await PDFParser.extractText(file);
    if (!pageTexts) throw new Error('PDF konnte nicht gelesen werden (pdf.js nicht verfügbar?)');
    return this._parseText(pageTexts.join('\n'));
  },

  _parseText(raw) {
    const text = raw.replace(/\r/g, '');
    const drivers = this._parseDrivers(text);
    if (!drivers.length) throw new Error('Keine Fahrerdaten gefunden – Ist es eine RCM-Ergebnisliste?');
    const lapRows = this._parseLapTimes(text);
    drivers.forEach((d, i) => {
      d.lapTimes = lapRows.map(row => (i < row.length ? row[i] : null)).filter(t => t !== null);
    });
    return { drivers, ...this._parseMeta(text) };
  },

  _parseMeta(text) {
    const nameM = text.match(/((?:[A-Z]-)?Finale[^\n|]{0,60}|Vorlauf\s*\d+[^\n]{0,40})/i);
    const dateM = text.match(/Datum:\s*(\d{2}\.\d{2}\.\d{4})/i);
    const trackM = text.match(/Strecke:\s*([^\n]+)/i);
    return {
      raceName: nameM ? nameM[1].trim().replace(/\s+/g, ' ') : 'Rennen',
      raceDate: dateM ? dateM[1] : null,
      track:    trackM ? trackM[1].split('|')[0].trim() : null
    };
  },

  _parseDrivers(text) {
    const list = [];
    // Columns: Pos Nr Name(lazy, stops at first decimal) [optional I] Rundenzeit Rnd Absolutzeit Bestzeit Mediumzeit StDev
    const re = /^\s*(\d{1,2})\s+(\d{1,3})\s+(.+?)\s+(?:I\s+)?(\d+\.\d{3})\s+(\d+)\s+(\d+:[\d.]+)\s+(\d+\.\d{3})\s+(\d+\.\d{3})\s+(\d+\.\d{3})/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[3].trim().replace(/\s+I\s*$/, '');
      if (!name || /^\d/.test(name)) continue;
      list.push({
        pos:      +m[1],
        nr:       m[2],
        name,
        laps:     +m[5],
        bestTime: +m[7],
        medTime:  +m[8],
        stdev:    +m[9],
        lapTimes: []
      });
    }
    return list.sort((a, b) => a.pos - b.pos);
  },

  _parseLapTimes(text) {
    const idx = text.search(/Rundenzeiten/i);
    if (idx < 0) return [];
    const rows = [];
    for (const line of text.slice(idx + 12).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      // Stop at next real section header (not at driver name lines in the table header)
      if (/^(Rekorde|Klasse\s|PW Cup Lauf|Ausrichter|Datum:|Strecke:)/i.test(t)) break;
      // Only process lines starting with a digit (= lap number rows)
      if (!/^\d/.test(t)) continue;
      const parts = t.split(/\s+/);
      const lapNum = parseInt(parts[0], 10);
      if (isNaN(lapNum) || lapNum < 1) continue;
      const times = parts.slice(1).map(Number).filter(x => !isNaN(x) && x > 0);
      if (times.length) rows.push(times);
    }
    return rows;
  },

  save(result) {
    try {
      localStorage.setItem(this.STORE_KEY, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...result }));
    } catch (_) {}
  },

  load() {
    try {
      const raw = localStorage.getItem(this.STORE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d.version === 1 ? d : null;
    } catch (_) { return null; }
  },

  clear() { localStorage.removeItem(this.STORE_KEY); }
};

/* ════════════════════════════════════════════════════════════════════════════
   ANALYSE CONTROLLER
   ════════════════════════════════════════════════════════════════════════════ */
const AnalyseController = {
  _result:   null,
  _selected: new Set(),

  init() {
    const saved = AnalyseParser.load();
    if (saved) {
      this._result = saved;
      this._selected = new Set();
      this._showSelect();
    } else {
      this._showUpload();
    }
  },

  // ── Section switching ──────────────────────────────────────────────────────
  _showUpload() {
    document.getElementById('analyse-upload-wrap').classList.remove('hidden');
    document.getElementById('analyse-select-section').classList.add('hidden');
    document.getElementById('analyse-compare-section').classList.add('hidden');
    const inp = document.getElementById('input-analyse');
    inp.value = '';
    document.getElementById('fname-analyse').textContent = 'PDF-Datei auswählen…';
    document.getElementById('fname-analyse').classList.remove('selected');
    const st = document.getElementById('status-analyse');
    st.className = 'parse-status';
    st.textContent = '';
    inp.onchange = e => { if (e.target.files[0]) this._load(e.target.files[0]); };
    this._bindDrop('drop-analyse', f => this._load(f));
  },

  _showSelect() {
    document.getElementById('analyse-upload-wrap').classList.add('hidden');
    document.getElementById('analyse-select-section').classList.remove('hidden');
    document.getElementById('analyse-compare-section').classList.add('hidden');
    this._renderSelectUI();
  },

  _showCompare() {
    document.getElementById('analyse-upload-wrap').classList.add('hidden');
    document.getElementById('analyse-select-section').classList.add('hidden');
    document.getElementById('analyse-compare-section').classList.remove('hidden');
    this._renderCompare();
  },

  // ── Driver selection UI ────────────────────────────────────────────────────
  _renderSelectUI() {
    const r   = this._result;
    const maxLaps = Math.max(...r.drivers.map(d => d.lapTimes.length), 0);

    let cards = '<div class="driver-cards">';
    r.drivers.forEach((d, i) => {
      const sel = this._selected.has(i);
      cards += `<div class="driver-card${sel ? ' selected' : ''}" data-idx="${i}">
        <div class="dc-badge">P${d.pos} <span class="dc-nr">#${d.nr}</span></div>
        <div class="dc-name">${d.name}</div>
        <div class="dc-stats">
          <span class="dc-best">${d.bestTime.toFixed(3)}</span>
          <span class="dc-laps">${d.laps} Rnd</span>
        </div>
      </div>`;
    });
    cards += '</div>';

    const sec = document.getElementById('analyse-select-section');
    sec.innerHTML = `
      <div class="analyse-meta">
        <div class="am-item"><span class="am-label">Rennen</span><span class="am-value">${r.raceName}</span></div>
        ${r.raceDate ? `<div class="am-item"><span class="am-label">Datum</span><span class="am-value">${r.raceDate}</span></div>` : ''}
        ${r.track ? `<div class="am-item"><span class="am-label">Strecke</span><span class="am-value">${r.track}</span></div>` : ''}
        <div class="am-item"><span class="am-label">Fahrer</span><span class="am-value">${r.drivers.length}</span></div>
        <div class="am-item"><span class="am-label">Runden</span><span class="am-value">${maxLaps}</span></div>
      </div>
      <div class="driver-select-hint">Fahrer antippen zum Auswählen:</div>
      ${cards}
      <div class="analyse-actions">
        <button class="btn btn-secondary" id="btn-sel-all">Alle</button>
        <button class="btn btn-primary" id="btn-sel-compare" disabled>Vergleich starten</button>
      </div>
      <div class="container mb-2">
        <button class="btn btn-secondary btn-full" id="btn-sel-newfile" style="min-height:38px;font-size:0.8rem;">
          &#128196; Neue Datei laden
        </button>
      </div>
    `;

    sec.querySelectorAll('.driver-card').forEach(card => {
      card.addEventListener('click', () => {
        const i = +card.dataset.idx;
        this._selected.has(i) ? this._selected.delete(i) : this._selected.add(i);
        this._syncCards();
      });
    });

    document.getElementById('btn-sel-all').addEventListener('click', () => {
      if (this._selected.size === r.drivers.length) this._selected.clear();
      else r.drivers.forEach((_, i) => this._selected.add(i));
      this._syncCards();
    });

    document.getElementById('btn-sel-compare').addEventListener('click', () => {
      if (this._selected.size) this._showCompare();
    });

    document.getElementById('btn-sel-newfile').addEventListener('click', () => {
      AnalyseParser.clear();
      this._result = null;
      this._selected = new Set();
      this._showUpload();
    });

    this._syncCards();
  },

  _syncCards() {
    const sec = document.getElementById('analyse-select-section');
    if (!sec) return;
    sec.querySelectorAll('.driver-card').forEach(card => {
      card.classList.toggle('selected', this._selected.has(+card.dataset.idx));
    });
    const btnCmp = document.getElementById('btn-sel-compare');
    const btnAll = document.getElementById('btn-sel-all');
    if (btnCmp) {
      btnCmp.disabled = this._selected.size === 0;
      btnCmp.textContent = this._selected.size
        ? `Vergleich starten (${this._selected.size})`
        : 'Vergleich starten';
    }
    if (btnAll) {
      btnAll.textContent = this._selected.size === this._result.drivers.length
        ? 'Alle ab' : 'Alle';
    }
  },

  // ── Comparison table ───────────────────────────────────────────────────────
  _renderCompare() {
    const r = this._result;
    const drivers = r.drivers.filter((_, i) => this._selected.has(i));
    if (!drivers.length) { this._showSelect(); return; }

    // Assign a distinct color per driver
    const PALETTE = ['#ff6b00','#3b82f6','#22c55e','#facc15','#ec4899','#06b6d4','#a855f7','#f87171'];
    drivers.forEach((d, i) => { d._color = PALETTE[i % PALETTE.length]; });

    const maxLaps = Math.max(...drivers.map(d => d.lapTimes.length), 0);

    // Overall fastest (skip lap 0 = standing start)
    let globalBest = Infinity;
    drivers.forEach(d => d.lapTimes.slice(1).forEach(t => { if (t < globalBest) globalBest = t; }));
    drivers.forEach(d => { d.pb = d.lapTimes.slice(1).length ? Math.min(...d.lapTimes.slice(1)) : Infinity; });

    // Table header — colored top border per driver, no sparkline
    let thead = '<tr><th class="lt-sticky lt-col-lap">#</th>';
    drivers.forEach(d => {
      thead += `<th class="lt-col-driver" style="border-top:3px solid ${d._color}">
        <div class="lt-drv-pos">P${d.pos} <span style="color:var(--muted);font-weight:400">#${d.nr}</span></div>
        <div class="lt-drv-name">${d.name}</div>
      </th>`;
    });
    thead += '</tr>';

    let tbody = '';
    for (let i = 0; i < maxLaps; i++) {
      tbody += `<tr><td class="lt-sticky lt-lap-num">${i + 1}</td>`;
      drivers.forEach(d => {
        const t = d.lapTimes[i];
        if (t == null) { tbody += '<td class="lt-time lt-empty">—</td>'; return; }
        let cls = 'lt-time';
        if      (i === 0)          cls += ' lt-start';
        else if (t === globalBest) cls += ' lt-fastest';
        else if (t === d.pb)       cls += ' lt-pb';
        else if (t > d.pb * 1.08)  cls += ' lt-slow';
        tbody += `<td class="${cls}">${t.toFixed(3)}</td>`;
      });
      tbody += '</tr>';
    }

    tbody += '<tr class="lt-sum-row"><td class="lt-sticky lt-lap-num">Ø</td>';
    drivers.forEach(d => {
      tbody += `<td class="lt-summary">
        <div class="lt-sum-val">${d.medTime.toFixed(3)}</div>
        <div class="lt-sum-dev">σ ${d.stdev.toFixed(3)}</div>
      </td>`;
    });
    tbody += '</tr>';

    const sec = document.getElementById('analyse-compare-section');
    sec.innerHTML = `
      <div class="compare-back-bar">
        <button class="btn-back-small" id="btn-cmp-back">&#9664; Fahrerwahl</button>
        <span class="compare-title">${r.raceName}</span>
      </div>
      ${this._combinedChart(drivers)}
      <div class="lap-table-wrap">
        <table class="lap-table">
          <thead>${thead}</thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
      <div class="lt-legend">
        <span class="lt-legend-item"><span class="lt-legend-dot lt-fastest"></span>Schnellste Runde</span>
        <span class="lt-legend-item"><span class="lt-legend-dot lt-pb"></span>Pers. Bestzeit</span>
        <span class="lt-legend-item"><span class="lt-legend-dot lt-slow"></span>&gt;8% über Bestzeit</span>
      </div>
    `;

    document.getElementById('btn-cmp-back').addEventListener('click', () => this._showSelect());
  },

  _combinedChart(drivers) {
    const W = 800, H = 140, pX = 10, pY = 12;

    // Skip standing-start lap (index 0)
    const allTimes = drivers.flatMap(d => d.lapTimes.slice(1));
    if (allTimes.length < 2) return '';

    const mn      = Math.min(...allTimes);
    const rawMx   = Math.max(...allTimes);
    // Cap outliers so normal laps fill ~85% of chart height
    const mx      = Math.min(rawMx, mn * 1.25);
    const rng     = mx - mn || 0.001;
    const lapCnt  = Math.max(...drivers.map(d => d.lapTimes.length - 1));
    if (lapCnt < 2) return '';

    // Subtle horizontal grid lines
    const gridInterval = rng > 2 ? 1.0 : rng > 0.8 ? 0.5 : 0.2;
    let grid = '';
    const firstGrid = Math.ceil(mn / gridInterval) * gridInterval;
    for (let v = firstGrid; v <= mx + 0.001; v += gridInterval) {
      const y = (H - pY - ((v - mn) / rng) * (H - pY * 2)).toFixed(1);
      grid += `<line x1="${pX}" y1="${y}" x2="${W - pX}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
    }

    // One polyline per driver — fast laps = low on chart, slow = high
    let lines = '';
    drivers.forEach(d => {
      const laps = d.lapTimes.slice(1);
      if (laps.length < 2) return;
      const pts = laps.map((t, i) => {
        const x  = (pX + (i / (lapCnt - 1)) * (W - pX * 2)).toFixed(1);
        const tc = Math.min(t, mx); // clamp outlier to top of visible range
        const y  = (H - pY - ((tc - mn) / rng) * (H - pY * 2)).toFixed(1);
        return `${x},${y}`;
      }).join(' ');
      lines += `<polyline points="${pts}" fill="none" stroke="${d._color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`;
      // Mark personal best lap with a small dot
      const pbIdx = laps.indexOf(Math.min(...laps));
      if (pbIdx >= 0) {
        const bx = (pX + (pbIdx / (lapCnt - 1)) * (W - pX * 2)).toFixed(1);
        const bt = Math.min(laps[pbIdx], mx);
        const by = (H - pY - ((bt - mn) / rng) * (H - pY * 2)).toFixed(1);
        lines += `<circle cx="${bx}" cy="${by}" r="4" fill="${d._color}" opacity="0.95"/>`;
      }
    });

    // Legend as HTML below the SVG
    const legend = drivers.map(d =>
      `<span class="ccl-item">
        <svg width="22" height="4" viewBox="0 0 22 4" style="display:inline-block;vertical-align:middle;margin-right:5px">
          <line x1="0" y1="2" x2="22" y2="2" stroke="${d._color}" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <span class="ccl-name">P${d.pos} ${d.name}</span>
      </span>`
    ).join('');

    return `
      <div class="combined-chart-wrap">
        <svg class="combined-chart-svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
          <rect width="${W}" height="${H}" fill="rgba(8,9,14,0.6)"/>
          ${grid}${lines}
        </svg>
        <div class="combined-chart-legend">${legend}</div>
      </div>`;
  },

  // ── File loading ───────────────────────────────────────────────────────────
  async _load(file) {
    const st = document.getElementById('status-analyse');
    document.getElementById('fname-analyse').textContent = file.name;
    document.getElementById('fname-analyse').classList.add('selected');
    st.className = 'parse-status loading';
    st.innerHTML = '<span class="spinner"></span> Analysiere…';
    try {
      const result = await AnalyseParser.parse(file);
      AnalyseParser.save(result);
      this._result = result;
      this._selected = new Set();
      const maxLaps = Math.max(...result.drivers.map(d => d.lapTimes.length), 0);
      st.className = 'parse-status ok';
      st.textContent = `✓ ${result.drivers.length} Fahrer · ${maxLaps} Runden`;
      setTimeout(() => this._showSelect(), 500);
    } catch (err) {
      st.className = 'parse-status error';
      st.textContent = `✕ ${err.message}`;
    }
  },

  _bindDrop(id, cb) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', e => {
      e.preventDefault(); el.classList.remove('drag-over');
      const f = e.dataTransfer.files[0]; if (f) cb(f);
    });
  },

};

/* ════════════════════════════════════════════════════════════════════════════
   SUMMARY RENDERER
   ════════════════════════════════════════════════════════════════════════════ */
const SummaryRenderer = {
  render() {
    const d    = State.data;
    const card = document.getElementById('summary-card');
    if (!d) return;

    let html = `
      <div class="summary-stat">
        <span class="summary-stat-label">Fahrer</span>
        <span class="summary-stat-value">${d.driverName}</span>
      </div>
    `;

    d.dashboards.forEach(dash => {
      const done = dash.races.filter(r => r.status === 'done').length;
      html += `
        <div class="summary-stat">
          <span class="summary-stat-label">${dash.driverClass} · ${dash.driverGroup}</span>
          <span class="summary-stat-value">${done} / ${dash.races.length} Läufe</span>
        </div>
      `;
    });

    card.innerHTML = html;
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   APP — bootstrap and navigation
   ════════════════════════════════════════════════════════════════════════════ */
const App = {
  _currentView: null,
  _prevView:    null,

  init() {
    State.load();
    State.migrate();
    this._bindGlobalEvents();

    if (State.data && State.data.setupComplete) {
      const allDone = State.data.dashboards.every(d => d.races.every(r => r.status === 'done'));
      if (allDone) {
        this.showView('summary');
        SummaryRenderer.render();
      } else {
        this.launchDashboard();
      }
    } else {
      this.showView('setup');
      SetupController.init();
    }
  },

  showView(id) {
    this._prevView    = this._currentView;
    this._currentView = id;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${id}`);
    if (target) target.classList.add('active');

    const btnReset    = document.getElementById('btn-nav-reset');
    const btnSettings = document.getElementById('btn-nav-settings');
    const btnAnalyse  = document.getElementById('btn-nav-analyse');
    btnReset.classList.toggle('hidden', id === 'setup' || id === 'analyse');
    btnSettings.classList.toggle('hidden', id !== 'dashboard');
    if (btnAnalyse) btnAnalyse.classList.toggle('active-analyse', id === 'analyse');
  },

  launchDashboard() {
    CountdownController.stop();
    this.showView('dashboard');
    DashboardRenderer.renderAll();
    CountdownController.start();
  },

  _bindGlobalEvents() {
    document.getElementById('btn-modal-confirm').addEventListener('click', () => {
      SoundEngine.unlock();
      ModalController.confirm();
    });

    document.addEventListener('click', e => {
      const hdr = e.target.closest('.race-list-toggle');
      if (hdr) {
        const rl = hdr.closest('.race-list');
        if (rl) {
          const collapsed = rl.classList.toggle('collapsed');
          const chevron = hdr.querySelector('.race-list-chevron');
          if (chevron) chevron.textContent = collapsed ? '▶' : '▼';
        }
      }
    });

    document.addEventListener('click', e => {
      const btn = e.target.closest('.btn-adjust-panel');
      if (!btn || !State.data) return;
      SoundEngine.unlock();
      const dashIdx = parseInt(btn.dataset.dash, 10);
      const delta   = parseInt(btn.dataset.delta, 10);
      if (!delta || isNaN(dashIdx)) return;
      const dash = State.data.dashboards[dashIdx];
      if (!dash) return;
      dash.globalOffsetMs = (dash.globalOffsetMs || 0) + (delta * 1000);
      State.save();
      DashboardRenderer.renderPanel(dashIdx);
    });

    document.getElementById('btn-nav-analyse').addEventListener('click', () => {
      CountdownController.stop();
      this.showView('analyse');
      AnalyseController.init();
    });

    document.getElementById('btn-analyse-back').addEventListener('click', () => {
      const dest = this._prevView || 'setup';
      this.showView(dest);
      if (dest === 'dashboard') CountdownController.start();
    });

    document.getElementById('btn-nav-settings').addEventListener('click', () => {
      CountdownController.stop();
      this.showView('setup');
      SetupController.init();
    });

    document.getElementById('btn-nav-reset').addEventListener('click', () => {
      if (confirm('Alle Daten löschen und neu starten?')) {
        CountdownController.stop();
        State.reset();
      }
    });

    document.getElementById('btn-new-event').addEventListener('click', () => {
      CountdownController.stop();
      State.reset();
    });

    document.addEventListener('click', () => SoundEngine.unlock(), { once: true });
  }
};

/* ── Boot ─────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => App.init());
