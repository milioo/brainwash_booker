import express from 'express';
import cron from 'node-cron';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HEADLESS = String(process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';
const BOOKING_ENABLED = String(process.env.BOOKING_ENABLED ?? 'false').toLowerCase() === 'true';
const TIMEZONE = process.env.TZ || 'Europe/Amsterdam';

fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_STATE = {
  settings: {
    salon: 'BrainWash Castricum',
    bookingUrl: 'https://www.brainwash-kappers.nl/afspraak-maken/brainwash-castricum',
    treatment: 'Wassen, knippen, drogen Heer',
    stylist: 'No preference',
    weekdayAfter: '17:00',
    saturdayAny: true,
    cadence: 'monthly',
    bookingMode: 'approval',
    horizonDays: 45
  },
  profile: { firstName: '', lastName: '', email: '', phone: '' },
  candidates: [],
  bookings: [],
  lastCheck: null,
  lastDiagnostic: null
};

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
      profile: { ...DEFAULT_STATE.profile, ...(parsed.profile || {}) }
    };
  } catch {
    writeState(DEFAULT_STATE);
    return structuredClone(DEFAULT_STATE);
  }
}

function writeState(state) {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const monthMap = {
  jan: 0, januari: 0, feb: 1, februari: 1, mrt: 2, maart: 2, apr: 3, april: 3,
  mei: 4, jun: 5, juni: 5, jul: 6, juli: 6, aug: 7, augustus: 7,
  sep: 8, sept: 8, september: 8, okt: 9, oktober: 9, nov: 10, november: 10,
  dec: 11, december: 11
};

function parseDateFromText(raw, now = new Date()) {
  const text = normalizeText(raw).toLowerCase();
  let m = text.match(/\b(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?\b/);
  if (m) {
    let year = m[3] ? Number(m[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
    if (!m[3] && d < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2)) d.setFullYear(year + 1);
    return d;
  }
  m = text.match(/\b(\d{1,2})\s+(jan(?:uari)?|feb(?:ruari)?|mrt|maart|apr(?:il)?|mei|jun(?:i)?|jul(?:i)?|aug(?:ustus)?|sep(?:t(?:ember)?)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?\b/);
  if (!m) return null;
  const key = m[2];
  const month = monthMap[key] ?? monthMap[key.slice(0, 3)];
  if (month == null) return null;
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  const d = new Date(year, month, Number(m[1]), 12, 0, 0);
  if (!m[3] && d < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2)) d.setFullYear(year + 1);
  return d;
}

function timeToMinutes(time) {
  const m = String(time).match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function isPreferredSlot(date, time, settings) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return false;
  const day = date.getDay();
  if (day === 6) return Boolean(settings.saturdayAny);
  if (day >= 2 && day <= 5) {
    const mins = timeToMinutes(time);
    return mins != null && mins >= timeToMinutes(settings.weekdayAfter || '17:00');
  }
  return false;
}

async function dismissCookieBanner(page) {
  const patterns = [/accepteren/i, /alle cookies/i, /akkoord/i, /accept all/i];
  for (const pattern of patterns) {
    const button = page.getByRole('button', { name: pattern }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
      return;
    }
  }
}

async function clickFirstMatching(page, patterns, label) {
  for (const pattern of patterns) {
    const candidates = [
      page.getByRole('button', { name: pattern }).first(),
      page.getByRole('link', { name: pattern }).first(),
      page.getByText(pattern).first(),
      page.locator('label').filter({ hasText: pattern }).first()
    ];
    for (const item of candidates) {
      if (await item.isVisible().catch(() => false)) {
        try {
          await item.click({ timeout: 5000 });
          await page.waitForTimeout(700);
          return true;
        } catch {
          // Try the next locator. A visible text node is not always clickable.
        }
      }
    }
  }
  console.warn(`Could not find ${label}`);
  return false;
}

async function getDiagnostic(page) {
  const buttons = await page.locator('button:visible, [role="button"]:visible, a:visible').evaluateAll(nodes =>
    nodes.slice(0, 80).map(n => (n.innerText || n.getAttribute('aria-label') || n.getAttribute('title') || '').trim()).filter(Boolean)
  ).catch(() => []);
  const body = await page.locator('body').innerText().catch(() => '');
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    controls: [...new Set(buttons)].slice(0, 60),
    textExcerpt: normalizeText(body).slice(0, 5000)
  };
}

async function enterBookingFlow(page, settings) {
  await page.goto(settings.bookingUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForURL(/\/booking\/treatment-selection/, { timeout: 45000 });
  await dismissCookieBanner(page);

  // Aimy first asks for a customer category before it displays treatments.
  const category = page.getByText('Heren', { exact: true }).first();
  await category.waitFor({ state: 'visible', timeout: 15000 });
  await category.click();
  await page.getByRole('button', { name: /^Bevestig$/i }).click();

  const treatment = page.getByText(/Wassen,\s*knippen,\s*drogen\s+Heer/i).first();
  await treatment.waitFor({ state: 'visible', timeout: 15000 });
  await treatment.click();
  await page.getByRole('button', { name: /Volgende stap/i }).click();

  // Choosing a date makes Aimy use "Geen voorkeur" for the employee.
  await page.waitForURL(/\/booking\/date-or-stylist/, { timeout: 15000 });
  await page.getByRole('button', { name: /^Datum$/i }).click();
  await page.waitForURL(/\/booking\/date-time-selection/, { timeout: 15000 });
  await page.locator('.time-slots__slot-container[title]').first()
    .waitFor({ state: 'visible', timeout: 15000 });
}

async function extractVisibleSlots(page, settings) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const horizon = new Date(now.getTime() + Number(settings.horizonDays || 45) * 86400000);
  const dedupe = new Map();

  const rowDates = await page.locator('.time-slots__slot-container[title]').evaluateAll(nodes =>
    [...new Set(nodes.map(node => node.getAttribute('title')).filter(Boolean))]
  );

  for (const rawDate of rowDates) {
    const date = parseDateFromText(rawDate, now);
    if (!date || date < today || date > horizon) continue;

    const day = date.getDay();
    if (day !== 6 && !(day >= 2 && day <= 5)) continue;

    // Aimy initially shows only two times. Expand +N and then "Toon meer"
    // so late weekday appointments are included.
    const row = page.locator(`.time-slots__slot-container[title="${rawDate}"]`).first();
    const overflow = row.locator('.time-slots__slot-container__slots--overflow-slot');
    if (await overflow.isVisible().catch(() => false)) {
      await overflow.click();
      await page.waitForTimeout(250);
    }

    const showMore = row
      .locator('.time-slots__slot-container__slots--show-more')
      .filter({ hasText: /^Toon meer$/i });
    if (await showMore.isVisible().catch(() => false)) {
      await showMore.click();
      await page.waitForTimeout(250);
    }

    const times = await row
      .locator('.time-slots__slot-container__slots--slot')
      .allTextContents();

    for (const time of times) {
      const match = normalizeText(time).match(/^\d{1,2}:\d{2}$/);
      if (!match) continue;
      const hhmm = match[0].padStart(5, '0');
      if (!isPreferredSlot(date, hhmm, settings)) continue;
      const isoDate = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
      const key = `${isoDate}T${hhmm}`;
      dedupe.set(key, {
        id: crypto.createHash('sha1').update(key).digest('hex').slice(0, 12),
        date: isoDate,
        time: hhmm,
        display: `${isoDate} ${hhmm}`,
        sourceText: `${rawDate} ${hhmm}`
      });
    }
  }
  return [...dedupe.values()].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

async function availabilityCheck() {
  const state = readState();
  let browser;
  let page;
  try {
    browser = await chromium.launch({ headless: HEADLESS });
    page = await browser.newPage({ locale: 'nl-NL', timezoneId: TIMEZONE });
    await enterBookingFlow(page, state.settings);
    const candidates = await extractVisibleSlots(page, state.settings);
    const diagnostic = await getDiagnostic(page);
    state.candidates = candidates.slice(0, 30);
    state.lastCheck = new Date().toISOString();
    state.lastDiagnostic = { ok: true, candidateCount: candidates.length, ...diagnostic };
    writeState(state);
    return { ok: true, candidates: state.candidates, diagnostic: state.lastDiagnostic };
  } catch (error) {
    const diagnostic = page
      ? await getDiagnostic(page).catch(() => ({ url: page.url() }))
      : {};
    state.lastCheck = new Date().toISOString();
    state.lastDiagnostic = { ok: false, error: error.message, code: error.code || 'UNKNOWN', ...diagnostic };
    writeState(state);
    console.error('Availability check failed:', {
      code: state.lastDiagnostic.code,
      error: state.lastDiagnostic.error,
      url: state.lastDiagnostic.url
    });
    return { ok: false, candidates: [], diagnostic: state.lastDiagnostic };
  } finally {
    await browser?.close();
  }
}

async function fillByLabelOrPlaceholder(page, patterns, value) {
  if (!value) return false;
  for (const pattern of patterns) {
    const byLabel = page.getByLabel(pattern).first();
    if (await byLabel.isVisible().catch(() => false)) {
      await byLabel.fill(value);
      return true;
    }
    const byPlaceholder = page.getByPlaceholder(pattern).first();
    if (await byPlaceholder.isVisible().catch(() => false)) {
      await byPlaceholder.fill(value);
      return true;
    }
  }
  return false;
}

async function bookCandidate(candidateId) {
  const state = readState();
  const candidate = state.candidates.find(c => c.id === candidateId);
  if (!candidate) throw new Error('Candidate not found. Run a fresh availability check.');
  const missing = Object.entries(state.profile).filter(([, v]) => !String(v || '').trim()).map(([k]) => k);
  if (missing.length) throw new Error(`Complete your profile first: ${missing.join(', ')}`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage({ locale: 'nl-NL', timezoneId: TIMEZONE });
  try {
    await enterBookingFlow(page, state.settings);
    await page.waitForTimeout(1200);

    const targetTime = page.getByRole('button', { name: new RegExp(candidate.time.replace(':', '\\s*:\\s*'), 'i') });
    let clicked = false;
    const count = await targetTime.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = targetTime.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const context = await el.evaluate(node => {
        let s = node.innerText || '';
        let p = node.parentElement;
        for (let i = 0; i < 4 && p; i++, p = p.parentElement) s += ' ' + (p.innerText || '');
        return s;
      });
      const parsed = parseDateFromText(context);
      const parsedIso = parsed ? `${parsed.getFullYear()}-${String(parsed.getMonth()+1).padStart(2,'0')}-${String(parsed.getDate()).padStart(2,'0')}` : '';
      if (parsedIso === candidate.date) {
        await el.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) throw new Error('The chosen slot is no longer visible. Run a fresh check.');
    await page.waitForTimeout(800);

    await fillByLabelOrPlaceholder(page, [/voornaam/i, /first name/i], state.profile.firstName);
    await fillByLabelOrPlaceholder(page, [/achternaam/i, /last name/i], state.profile.lastName);
    await fillByLabelOrPlaceholder(page, [/e-?mail/i], state.profile.email);
    await fillByLabelOrPlaceholder(page, [/telefoon/i, /phone/i, /mobiel/i], state.profile.phone);

    // Only tick required legal/booking consent, never optional marketing consent.
    const requiredConsent = page.locator('label').filter({ hasText: /voorwaarden|privacy|akkoord/i });
    const consentCount = await requiredConsent.count().catch(() => 0);
    for (let i = 0; i < consentCount; i++) {
      const label = requiredConsent.nth(i);
      const text = normalizeText(await label.innerText().catch(() => '')).toLowerCase();
      if (/nieuwsbrief|marketing|aanbiedingen/.test(text)) continue;
      const checkbox = label.locator('input[type="checkbox"]');
      if (await checkbox.count().catch(() => 0)) {
        if (!(await checkbox.isChecked().catch(() => false))) await checkbox.check().catch(() => {});
      }
    }

    const diagnostic = await getDiagnostic(page);
    if (!BOOKING_ENABLED) {
      return {
        ok: false,
        safetyBlocked: true,
        message: 'Booking reached the final form, but BOOKING_ENABLED=false. Review the live diagnostic before enabling submission.',
        diagnostic
      };
    }

    const submitPatterns = [/bevestig.*afspraak/i, /afspraak.*maken/i, /boeken/i, /reserveer/i, /confirm/i];
    const submitted = await clickFirstMatching(page, submitPatterns, 'final booking button');
    if (!submitted) throw new Error('Final booking button not found; no booking was submitted.');
    await page.waitForTimeout(1500);

    const confirmationText = normalizeText(await page.locator('body').innerText().catch(() => ''));
    if (!/bevestigd|gelukt|afspraak.*gemaakt|confirmation|confirmed/i.test(confirmationText)) {
      throw new Error('Submission was attempted but confirmation could not be verified. Check Aimy manually before retrying.');
    }

    const booking = { ...candidate, bookedAt: new Date().toISOString(), status: 'confirmed' };
    state.bookings.unshift(booking);
    state.candidates = state.candidates.filter(c => c.id !== candidate.id);
    writeState(state);
    return { ok: true, booking };
  } finally {
    await browser.close();
  }
}

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true, bookingEnabled: BOOKING_ENABLED, timezone: TIMEZONE }));
app.get('/api/state', (_req, res) => res.json({ ...readState(), runtime: { bookingEnabled: BOOKING_ENABLED, timezone: TIMEZONE } }));

app.put('/api/settings', (req, res) => {
  const state = readState();
  const allowedCadence = ['monthly', 'fourWeeks'];
  const allowedMode = ['approval', 'auto'];
  const next = req.body || {};
  state.settings.cadence = allowedCadence.includes(next.cadence) ? next.cadence : state.settings.cadence;
  state.settings.bookingMode = allowedMode.includes(next.bookingMode) ? next.bookingMode : state.settings.bookingMode;
  if (/^\d{2}:\d{2}$/.test(next.weekdayAfter || '')) state.settings.weekdayAfter = next.weekdayAfter;
  state.settings.saturdayAny = next.saturdayAny !== false;
  writeState(state);
  res.json({ ok: true, settings: state.settings });
});

app.put('/api/profile', (req, res) => {
  const state = readState();
  for (const key of ['firstName', 'lastName', 'email', 'phone']) {
    state.profile[key] = String(req.body?.[key] || '').trim().slice(0, 150);
  }
  writeState(state);
  res.json({ ok: true, profile: state.profile });
});

app.post('/api/check', async (_req, res) => {
  const result = await availabilityCheck();
  if (!result.ok) {
    return res.status(502).json({
      ...result,
      error: result.diagnostic?.error || 'Availability check failed.'
    });
  }
  res.json(result);
});

app.post('/api/book/:id', async (req, res) => {
  try {
    const result = await bookCandidate(req.params.id);
    res.status(result.ok ? 200 : result.safetyBlocked ? 409 : 500).json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get('/{*splat}', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => console.log(`BrainWash Booker listening on :${PORT}`));

// Monthly: first day of each month at 09:00 Europe/Amsterdam.
cron.schedule('0 9 1 * *', async () => {
  const state = readState();
  if (state.settings.cadence !== 'monthly') return;
  const result = await availabilityCheck();
  if (result.ok && state.settings.bookingMode === 'auto' && result.candidates[0] && BOOKING_ENABLED) {
    await bookCandidate(result.candidates[0].id).catch(err => console.error('Auto-book failed:', err));
  }
}, { timezone: TIMEZONE });

// Every-4-weeks mode: daily trigger, but only run once 28 days have elapsed since the last check.
cron.schedule('5 9 * * *', async () => {
  const state = readState();
  if (state.settings.cadence !== 'fourWeeks') return;
  const last = state.lastCheck ? new Date(state.lastCheck) : null;
  if (last && Date.now() - last.getTime() < 28 * 86400000) return;
  const result = await availabilityCheck();
  if (result.ok && state.settings.bookingMode === 'auto' && result.candidates[0] && BOOKING_ENABLED) {
    await bookCandidate(result.candidates[0].id).catch(err => console.error('Auto-book failed:', err));
  }
}, { timezone: TIMEZONE });
