'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   STATE — single source of truth backed by LocalStorage
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

  setRaceStatus(index, status) {
    if (!this.data || !this.data.races[index]) return;
    this.data.races[index].status = status;
    this.save();
  },

  get currentRace() {
    if (!this.data) return null;
    return this.data.races[this.data.currentRaceIndex] || null;
  },

  effectiveStartMs(race) {
    if (!race || !race.scheduledTimeISO) return null;
    return new Date(race.scheduledTimeISO).getTime()
      + (race.offsetMs || 0)
      + (this.data.globalOffsetMs || 0);
  },

  applyOffset(deltaMs) {
    if (!this.data) return;
    this.data.globalOffsetMs = (this.data.globalOffsetMs || 0) + deltaMs;
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
    // Play silent buffer to unlock on iOS
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  },

  _tone(ctx, freq, startTime, duration, gain) {
    const osc  = ctx.createOscillator();
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
      // 3 measured beeps at 880 Hz
      for (let i = 0; i < 3; i++) {
        this._tone(ctx, 880, ctx.currentTime + i * 0.35, 0.2, 0.35);
      }
    } else {
      // 5 rapid urgent beeps at 1200 Hz
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
  _queue: [],
  _active: false,

  show(minutes) {
    if (this._active) {
      this._queue.push(minutes);
      return;
    }
    this._active = true;

    const overlay   = document.getElementById('modal-overlay');
    const icon      = document.getElementById('modal-icon');
    const title     = document.getElementById('modal-title-text');
    const body      = document.getElementById('modal-body-text');
    const confirmBtn = document.getElementById('btn-modal-confirm');

    if (minutes === 15) {
      icon.textContent  = '🚗';
      title.textContent = '15 Minuten – Vorbereitung!';
      title.className   = 'modal-title warn-15';
      body.innerHTML    = '<strong>Haftmittel auf die Reifen auftragen!</strong><br><br>Stelle sicher, dass die Reifen gleichmäßig behandelt sind.';
    } else {
      icon.textContent  = '⚠️';
      title.textContent = '5 Minuten – Abnahme!';
      title.className   = 'modal-title warn-5';
      body.innerHTML    = '<strong>Technische Abnahme steht an!</strong><br><br>Bitte Fahrzeug sofort zur Abnahme vorführen.';
    }

    overlay.classList.remove('hidden');
    confirmBtn.focus();
  },

  confirm() {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.add('hidden');
    this._active = false;
    if (this._queue.length > 0) {
      this.show(this._queue.shift());
    }
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   PDF PARSER — ports Python text-fallback logic from Gozilla-Racing 2 Dev
   ════════════════════════════════════════════════════════════════════════════ */
const PDFParser = {
  // Regex patterns ported exactly from pdf_parser.py
  HEADING_RE:            /(?<klasse>[^[\-]+?)\s*(?:\[[^\]]+\])?\s*[–\-|/]\s*(?<art>[^–\-|/]+?)\s*[–\-|/]\s*(?:(?<lauf_nr>\d+)\s*[–\-|/]\s*)?(?<gruppe>Gruppe\s+\S+)/i,
  FINALE_HEADING_RE:     /(?<art>[A-Z]-Finale)\s+(?<klasse>[^\n]+)/i,
  TEXT_DATA_ROW_RE:      /^\d+\.\s+(?:\d{4,6}\s+){0,2}(?<name>[A-ZÄÖÜ][^/\n]+?)(?=\s+(?:[A-Z]{3}\b|\d+\/\d)|$)/u,
  ZEITPLAN_FINALE_ROW_RE:/^(?<zeit>\d{1,2}:\d{2})\s+(?:\d{1,2}:\d{2}\s+)?(?<nr>\d+)\.\s+(?<art>[A-Z]-Finale)\s+(?<klasse>\S.*)/i,
  FINALE_NAME_RE:        /(?<!\d)(?<lastname>[A-ZÄÖÜ][a-zA-ZäöüÄÖÜß\-]{1,25}),\s*(?<firstname>[A-ZÄÖÜ][a-zA-ZäöüÄÖÜß\-]{1,25})/u,
  SKIP_RE:               /^(#|nr|pos|name|fahrer|teilnehmer|startposition|start\s*nr|platz|\s*)$/i,
  COL_HEADER_RE:         /^(nr|liz|zusatz|name|nat|club|tx|freq|temp|p\s+klasse|klasse)/i,
  ZEITPLAN_TABLE_HEADER_RE: /startzeit/i,

  async extractText(file) {
    if (!window.pdfjsLib) return null;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const pageTexts = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page  = await pdf.getPage(p);
        const tc    = await page.getTextContent();
        // Group items by y-band (same line = within 3pt), join with space; lines join with \n
        const lines = [];
        let currentY = null;
        let currentLine = [];
        for (const item of tc.items) {
          if (!item.str) continue;
          const y = Math.round(item.transform[5]);
          if (currentY === null) {
            currentY = y;
          } else if (Math.abs(y - currentY) > 3) {
            if (currentLine.length) lines.push(currentLine.join(' '));
            currentLine = [];
            currentY = y;
          }
          currentLine.push(item.str);
        }
        if (currentLine.length) lines.push(currentLine.join(' '));
        pageTexts.push(lines.join('\n'));
      }
      return pageTexts;
    } catch (e) {
      console.error('pdf.js extraction error:', e);
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
      const gruppe = `Gruppe ${art[0].toUpperCase()}`;
      return { klasse, art, gruppe };
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
    let current = null;
    let isFinale = false;

    for (const pageText of pageTexts) {
      for (const rawLine of pageText.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        const heading = this._parseHeading(line);
        if (heading) {
          if (current && current.drivers.length) groups.push(current);
          current = { klasse: heading.klasse, art: heading.art, gruppe: heading.gruppe, drivers: [] };
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
    const seen = new Set();

    for (const pageText of pageTexts) {
      // Try to parse structured table rows (Zeit Dauer Nr. Art Klasse)
      for (const rawLine of pageText.split('\n')) {
        const line = rawLine.trim();
        const m = this.ZEITPLAN_FINALE_ROW_RE.exec(line);
        if (!m) continue;
        if (m.groups.nr !== '1') continue; // keep earliest run only

        const art    = m.groups.art.trim();
        const klasse = m.groups.klasse.replace(/\s+\d{1,2}:\d{2}\s*$/, '').trim();
        const zeit   = m.groups.zeit;
        const gruppe = `Gruppe ${art[0].toUpperCase()}`;
        const key    = `${klasse.toLowerCase()}|${art.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        schedule.push({ klasse, gruppe, art, startzeit_hhmm: zeit });
      }

      // Also scan for structured table format (Klasse | Gruppe | Lauf | Startzeit columns)
      const tableEntries = this._parseZeitplanTable(pageText);
      for (const entry of tableEntries) {
        const key = `${entry.klasse.toLowerCase()}|${entry.gruppe.toLowerCase()}|${entry.art.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          schedule.push(entry);
        }
      }
    }
    return schedule;
  },

  _parseZeitplanTable(pageText) {
    const entries = [];
    // Look for rows with time patterns "HH:MM klasse gruppe art"
    // This handles the RC Race-Control table format
    const lines = pageText.split('\n');
    let inTable = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (this.ZEITPLAN_TABLE_HEADER_RE.test(line)) { inTable = true; continue; }
      if (!inTable) continue;
      // Match: time  group  class  run-type
      const m = /^(\d{1,2}:\d{2})\s+(.+)$/.exec(line);
      if (!m) continue;
      const zeit = m[1];
      const rest = m[2].trim();
      // Try to extract gruppe and klasse from rest
      const gm = /(Gruppe\s+\S+)\s+(.*)/i.exec(rest);
      if (gm) {
        const gruppe = gm[1].trim();
        const parts  = gm[2].trim().split(/\s{2,}|\t/);
        const klasse = parts[0] || '';
        const art    = parts[1] || 'Qualifikation';
        if (klasse) entries.push({ klasse, gruppe, art, startzeit_hhmm: zeit });
      }
    }
    return entries;
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   DASHBOARD RENDERER — all DOM writes isolated here
   ════════════════════════════════════════════════════════════════════════════ */
const DashboardRenderer = {
  renderAll() {
    this.renderDriverHeader();
    this.renderProgressBar();
    this.renderCurrentRace();
    this.renderRaceList();
    this.renderOffsetDisplay();
  },

  renderDriverHeader() {
    const d = State.data;
    if (!d) return;
    document.getElementById('dash-driver-name').textContent  = d.driverName || '—';
    document.getElementById('dash-badge-klasse').textContent = d.driverClass || '—';
    document.getElementById('dash-badge-gruppe').textContent = d.driverGroup || '—';
  },

  renderProgressBar() {
    const d = State.data;
    if (!d) return;
    const dots = document.querySelectorAll('.progress-dot');
    dots.forEach((dot, i) => {
      const race = d.races[i];
      if (!race) return;
      dot.className = `progress-dot ${i < 3 ? 'vorlauf' : 'finale'}`;
      if (race.status === 'done') {
        dot.classList.add('done');
      } else if (i === d.currentRaceIndex) {
        dot.classList.add('active');
      } else {
        dot.classList.add('pending');
      }
    });
  },

  renderCurrentRace() {
    const race = State.currentRace;
    if (!race) return;

    const isFinale = race.type === 'Finale';
    const card     = document.getElementById('race-card');
    card.className = `race-card ${isFinale ? 'active-finale' : 'active-vorlauf'}`;

    const typeBadge = document.getElementById('dash-race-type-badge');
    typeBadge.textContent = race.type;
    typeBadge.className   = `badge ${isFinale ? 'badge-final-type' : 'badge-vorlauf-type'}`;

    document.getElementById('dash-race-label').textContent  = race.label;
    document.getElementById('dash-race-gruppe').textContent = race.group || State.data.driverGroup;

    this.renderScheduledTime();
  },

  renderScheduledTime() {
    const race = State.currentRace;
    const el   = document.getElementById('dash-scheduled-time');
    if (!race || !race.scheduledTimeISO) {
      el.textContent = 'Zeit TBD';
      el.classList.add('scheduled-time-tbd');
      return;
    }
    const ms  = State.effectiveStartMs(race);
    const dt  = new Date(ms);
    const hh  = String(dt.getHours()).padStart(2, '0');
    const mm  = String(dt.getMinutes()).padStart(2, '0');
    el.textContent = `${hh}:${mm} Uhr`;
    el.classList.remove('scheduled-time-tbd');
  },

  renderCountdown(diffS) {
    const el     = document.getElementById('dash-countdown');
    const status = document.getElementById('dash-status-msg');
    const race   = State.currentRace;
    if (!race) return;

    if (race.status === 'running') {
      const elapsed = Math.abs(diffS);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      el.textContent = `${mm}:${ss}`;
      el.className   = 'countdown-value countdown-running';
      status.textContent = '🚦 Lauf läuft...';
      status.className   = 'status-msg running';
      status.classList.remove('hidden');
      return;
    }

    if (race.status === 'done') {
      el.textContent = '✓';
      el.className   = 'countdown-value countdown-done';
      status.textContent = '✓ Abgeschlossen';
      status.className   = 'status-msg done';
      status.classList.remove('hidden');
      return;
    }

    status.classList.add('hidden');

    if (diffS <= 0) {
      el.textContent = '00:00';
      el.className   = 'countdown-value countdown-running';
      return;
    }

    const mm = String(Math.floor(diffS / 60)).padStart(2, '0');
    const ss = String(diffS % 60).padStart(2, '0');
    el.textContent = `${mm}:${ss}`;

    if (diffS <= 300) {
      el.className = 'countdown-value countdown-urgent';
    } else if (diffS <= 900) {
      el.className = 'countdown-value countdown-soon';
    } else {
      el.className = 'countdown-value countdown-far';
    }
  },

  renderRaceList() {
    const d = State.data;
    if (!d) return;
    const list = document.getElementById('race-list');
    // Keep header, rebuild rows
    const header = list.querySelector('.race-list-header');
    list.innerHTML = '';
    list.appendChild(header);

    d.races.forEach((race, i) => {
      const isCurrent = i === d.currentRaceIndex;
      const isDone    = race.status === 'done';
      const isFinale  = race.type === 'Finale';

      const row = document.createElement('div');
      row.className = `race-list-row${isCurrent ? ' current' : ''}${isDone ? ' done' : ''}`;

      let dotClass = isFinale ? 'finale' : 'vorlauf';
      if (isDone)    dotClass += ' done';
      if (isCurrent) dotClass += ' current';

      let timeStr = '--:--';
      if (race.scheduledTimeISO) {
        const ms = State.effectiveStartMs(race);
        const dt = new Date(ms);
        timeStr  = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
      }

      let statusStr = '';
      if (isCurrent) statusStr = '▶';
      else if (isDone) statusStr = '✓';

      row.innerHTML = `
        <div class="race-list-dot ${dotClass}"></div>
        <div class="race-list-label">${race.label}</div>
        <div class="race-list-time">${timeStr}</div>
        <div class="race-list-status">${statusStr}</div>
      `;
      list.appendChild(row);
    });
  },

  renderOffsetDisplay() {
    const d  = State.data;
    const el = document.getElementById('offset-display');
    if (!d) return;
    const offsetMin = Math.round((d.globalOffsetMs || 0) / 60000);
    if (offsetMin === 0) {
      el.textContent = 'Kein Versatz aktiv';
      el.classList.remove('nonzero');
    } else {
      const sign = offsetMin > 0 ? '+' : '';
      el.textContent = `Aktueller Versatz: ${sign}${offsetMin} Min`;
      el.classList.add('nonzero');
    }
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
    if (!State.data) return;
    const race = State.currentRace;
    if (!race) return;

    // If race has no scheduled time, nothing to count down
    if (!race.scheduledTimeISO) return;

    const startMs = State.effectiveStartMs(race);
    const diffMs  = startMs - Date.now();
    const diffS   = Math.floor(diffMs / 1000);

    this._checkTransitions(diffS, race);
    DashboardRenderer.renderCountdown(diffS);
  },

  _checkTransitions(diffS, race) {
    const idx = State.data.currentRaceIndex;

    // 15-min warning window: between 841 and 900 seconds remaining
    if (diffS <= 900 && diffS > 840 && race.status === 'pending') {
      State.setRaceStatus(idx, 'warning_15');
      SoundEngine.beep(15);
      ModalController.show(15);
      return;
    }

    // 5-min warning window: between 241 and 300 seconds remaining
    if (diffS <= 300 && diffS > 240 && race.status === 'warning_15') {
      State.setRaceStatus(idx, 'warning_5');
      SoundEngine.beep(5);
      ModalController.show(5);
      return;
    }

    // Race starts — handle the edge case where we might skip warning_5 (app opened late)
    if (diffS <= 0 && (race.status === 'warning_5' || race.status === 'warning_15' || race.status === 'pending')) {
      State.setRaceStatus(idx, 'running');
      DashboardRenderer.renderProgressBar();
      DashboardRenderer.renderRaceList();
      return;
    }

    // Auto-advance: 5 minutes (300s) after race started (diffS goes to -300)
    if (diffS <= -300 && race.status === 'running') {
      this._advanceRace();
    }
  },

  _advanceRace() {
    const d = State.data;
    State.setRaceStatus(d.currentRaceIndex, 'done');

    const nextIndex = d.currentRaceIndex + 1;
    if (nextIndex >= d.races.length) {
      // All done — show summary
      App.showView('summary');
      SummaryRenderer.render();
      return;
    }

    d.currentRaceIndex = nextIndex;
    State.save();

    DashboardRenderer.renderAll();
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   SETUP CONTROLLER
   ════════════════════════════════════════════════════════════════════════════ */
const SetupController = {
  _groups:   null,
  _schedule: null,

  init() {
    // Restore previously parsed data if available
    try {
      const raw1 = localStorage.getItem('gr66_pdf_groups');
      const raw2 = localStorage.getItem('gr66_pdf_schedule');
      if (raw1) this._groups   = JSON.parse(raw1);
      if (raw2) this._schedule = JSON.parse(raw2);
    } catch (e) { /* ignore */ }

    if (this._groups && this._groups.length) this._showDriverStep();

    // File input handlers
    document.getElementById('input-gruppen').addEventListener('change', e => {
      if (e.target.files[0]) this._handleGruppenFile(e.target.files[0]);
    });
    document.getElementById('input-zeitplan').addEventListener('change', e => {
      if (e.target.files[0]) this._handleZeitplanFile(e.target.files[0]);
    });

    // Driver select
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

    // Demo
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

    // Deduplicate drivers across all groups
    const seen = new Set();
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

  _previewDriver(name) {
    const previewEl = document.getElementById('driver-preview');
    const textEl    = document.getElementById('driver-preview-text');
    const btn       = document.getElementById('btn-open-dashboard');

    if (!name) {
      previewEl.classList.add('hidden');
      btn.disabled = true;
      return;
    }

    const found = this._findDriverGroup(name);
    if (found) {
      textEl.innerHTML = `Klasse: <strong>${found.klasse}</strong> &nbsp;|&nbsp; Gruppe: <strong>${found.gruppe}</strong>`;
      previewEl.classList.remove('hidden');
    } else {
      textEl.textContent = 'Klasse/Gruppe nicht erkannt';
      previewEl.classList.remove('hidden');
    }
    btn.disabled = false;
  },

  _findDriverGroup(name) {
    if (!this._groups) return null;
    const needle = name.toLowerCase().trim();
    for (const g of this._groups) {
      for (const d of g.drivers) {
        if (d.toLowerCase().trim() === needle) {
          return { klasse: g.klasse, gruppe: g.gruppe, art: g.art };
        }
      }
    }
    return null;
  },

  _confirmDriver() {
    SoundEngine.unlock();
    const name = document.getElementById('select-driver').value;
    if (!name) return;

    const found = this._findDriverGroup(name);
    const klasse = found ? found.klasse : 'Unbekannt';
    const gruppe = found ? found.gruppe : 'Gruppe ?';

    const races = this._buildRaceArray(name, klasse, gruppe, this._groups, this._schedule || []);

    State.data = {
      version:          1,
      driverName:       name,
      driverClass:      klasse,
      driverGroup:      gruppe,
      races:            races,
      currentRaceIndex: 0,
      globalOffsetMs:   0,
      setupComplete:    true
    };
    State.save();

    App.launchDashboard();
  },

  _buildRaceArray(driverName, klasse, gruppe, groups, schedule) {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

    const raceSlots = [
      { type: 'Vorlauf', number: 1, label: 'Vorlauf 1', artKeywords: ['qualifikation', 'vorlauf', 'vl1', 'vl 1', '1'] },
      { type: 'Vorlauf', number: 2, label: 'Vorlauf 2', artKeywords: ['qualifikation', 'vorlauf', 'vl2', 'vl 2', '2'] },
      { type: 'Vorlauf', number: 3, label: 'Vorlauf 3', artKeywords: ['qualifikation', 'vorlauf', 'vl3', 'vl 3', '3'] },
      { type: 'Finale',  number: 1, label: 'Finale 1',  artKeywords: ['a-finale', 'finale 1', 'final 1'] },
      { type: 'Finale',  number: 2, label: 'Finale 2',  artKeywords: ['b-finale', 'finale 2', 'final 2'] },
      { type: 'Finale',  number: 3, label: 'Finale 3',  artKeywords: ['c-finale', 'finale 3', 'final 3'] },
    ];

    // Find all groups belonging to this driver to get alternative Gruppe strings
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

    return raceSlots.map((slot, i) => {
      // Find schedule entry matching class + relevant group + art
      let matchedTime = null;

      if (schedule && schedule.length) {
        // Try matching by art keyword
        for (const entry of schedule) {
          const entryArtLower   = entry.art.toLowerCase();
          const entryKlasseLower = entry.klasse.toLowerCase();
          const klasseLower      = klasse.toLowerCase();

          // Class must roughly match
          const klassesMatch = entryKlasseLower.includes(klasseLower.substring(0, 4)) ||
                               klasseLower.includes(entryKlasseLower.substring(0, 4));

          if (!klassesMatch) continue;

          // For Finale slots, match by art directly
          if (slot.type === 'Finale') {
            if (slot.artKeywords.some(kw => entryArtLower.includes(kw))) {
              matchedTime = entry.startzeit_hhmm;
              break;
            }
          } else {
            // For Vorlauf, match by group and qualifier number
            const entryGruppeLower = (entry.gruppe || '').toLowerCase();
            const gruppeLower      = gruppe.toLowerCase();
            const gruppeMatches    = entryGruppeLower === gruppeLower ||
                                     driverGroups.some(dg => dg.gruppe.toLowerCase() === entryGruppeLower);

            if (!gruppeMatches) continue;

            // Check art for the vorlauf number
            const artNum = entryArtLower.match(/\d+/);
            if (artNum && parseInt(artNum[0]) === slot.number) {
              matchedTime = entry.startzeit_hhmm;
              break;
            }
            // Generic qualifikation entry — use order
            if (/qualifikation|vorlauf/.test(entryArtLower) && !matchedTime) {
              matchedTime = entry.startzeit_hhmm;
            }
          }
        }
      }

      const scheduledTimeISO = matchedTime
        ? `${dateStr}T${matchedTime}:00`
        : null;

      return {
        id:               `race_${i}`,
        type:             slot.type,
        number:           slot.number,
        label:            slot.label,
        group:            gruppe,
        klasse:           klasse,
        scheduledTimeISO,
        offsetMs:         0,
        status:           'pending'
      };
    });
  },

  _startDemo() {
    const now    = Date.now();
    const today  = new Date();
    const pad    = n => String(n).padStart(2, '0');
    const toISO  = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const gap = 20 * 60 * 1000; // 20 minutes between races
    const labels = ['Vorlauf 1','Vorlauf 2','Vorlauf 3','Finale 1','Finale 2','Finale 3'];
    const types  = ['Vorlauf','Vorlauf','Vorlauf','Finale','Finale','Finale'];

    const races = labels.map((label, i) => ({
      id:               `race_${i}`,
      type:             types[i],
      number:           (i % 3) + 1,
      label,
      group:            'Gruppe A',
      klasse:           'Fun-Cup',
      scheduledTimeISO: toISO(now + (i + 1) * gap),
      offsetMs:         0,
      status:           'pending'
    }));

    State.data = {
      version:          1,
      driverName:       'Demo Fahrer',
      driverClass:      'Fun-Cup',
      driverGroup:      'Gruppe A',
      races,
      currentRaceIndex: 0,
      globalOffsetMs:   0,
      setupComplete:    true
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
   SUMMARY RENDERER
   ════════════════════════════════════════════════════════════════════════════ */
const SummaryRenderer = {
  render() {
    const d    = State.data;
    const card = document.getElementById('summary-card');
    if (!d) return;

    const finishedRaces = d.races.filter(r => r.status === 'done').length;
    card.innerHTML = `
      <div class="summary-stat">
        <span class="summary-stat-label">Fahrer</span>
        <span class="summary-stat-value">${d.driverName}</span>
      </div>
      <div class="summary-stat">
        <span class="summary-stat-label">Klasse</span>
        <span class="summary-stat-value">${d.driverClass}</span>
      </div>
      <div class="summary-stat">
        <span class="summary-stat-label">Gruppe</span>
        <span class="summary-stat-value">${d.driverGroup}</span>
      </div>
      <div class="summary-stat">
        <span class="summary-stat-label">Abgeschlossene Läufe</span>
        <span class="summary-stat-value">${finishedRaces} / ${d.races.length}</span>
      </div>
    `;
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   APP — bootstrap and navigation
   ════════════════════════════════════════════════════════════════════════════ */
const App = {
  init() {
    State.load();
    this._bindGlobalEvents();

    if (State.data && State.data.setupComplete) {
      // Check if all races are done
      const allDone = State.data.races.every(r => r.status === 'done');
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
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${id}`);
    if (target) target.classList.add('active');

    // Update nav buttons
    const btnReset    = document.getElementById('btn-nav-reset');
    const btnSettings = document.getElementById('btn-nav-settings');
    btnReset.classList.toggle('hidden', id === 'setup');
    btnSettings.classList.toggle('hidden', id !== 'dashboard');
  },

  launchDashboard() {
    CountdownController.stop();
    this.showView('dashboard');
    DashboardRenderer.renderAll();
    CountdownController.start();
  },

  _bindGlobalEvents() {
    // Modal confirm
    document.getElementById('btn-modal-confirm').addEventListener('click', () => {
      SoundEngine.unlock();
      ModalController.confirm();
    });

    // Adjust buttons
    document.querySelectorAll('.btn-adjust').forEach(btn => {
      btn.addEventListener('click', () => {
        SoundEngine.unlock();
        const delta = parseInt(btn.dataset.delta, 10);
        if (!delta || !State.data) return;
        // Don't adjust races already done or running
        State.applyOffset(delta * 1000);
        DashboardRenderer.renderScheduledTime();
        DashboardRenderer.renderRaceList();
        DashboardRenderer.renderOffsetDisplay();
      });
    });

    // Nav: settings → go back to setup
    document.getElementById('btn-nav-settings').addEventListener('click', () => {
      CountdownController.stop();
      this.showView('setup');
      SetupController.init();
    });

    // Nav: reset
    document.getElementById('btn-nav-reset').addEventListener('click', () => {
      if (confirm('Alle Daten löschen und neu starten?')) {
        CountdownController.stop();
        State.reset();
      }
    });

    // Summary: new event
    document.getElementById('btn-new-event').addEventListener('click', () => {
      CountdownController.stop();
      State.reset();
    });

    // Unlock audio on first any-click
    document.addEventListener('click', () => SoundEngine.unlock(), { once: true });
  }
};

/* ── Boot ─────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => App.init());
