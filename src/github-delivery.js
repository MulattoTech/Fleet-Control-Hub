'use strict';

// GitHub delivery is independent of local Codex sessions, AO, and canonical
// acceptance. Failed or incomplete API reads are unknown, never zero.
const API = 'https://api.github.com';
const REPO = 'MulattoTech/MJobs';
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 4;

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
}

async function getJSON(fetcher, url) {
  const response = await fetcher(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Fleet-Control-Hub' },
    signal: AbortSignal.timeout(3500)
  });
  if (!response?.ok) throw Error('GitHub request unavailable');
  return response.json();
}

function createGitHubDelivery({ fetcher = fetch, clock = Date.now, ttlMs = 300000 } = {}) {
  let snapshot = null;
  let expiresAt = 0;
  let pending = null;

  async function collect() {
    const observed = clock();
    const sinceUTC = new Date(observed - SEVEN_DAYS).toISOString().slice(0, 10);
    const query = 'repo:' + REPO + ' is:pr is:merged merged:>=' + sinceUTC;
    const mergedURL = API + '/search/issues?q=' + encodeURIComponent(query) + '&per_page=1';
    const openURL = page => API + '/repos/' + REPO + '/pulls?state=open&per_page=100&page=' + page;
    const [firstPage, merged] = await Promise.all([
      getJSON(fetcher, openURL(1)), getJSON(fetcher, mergedURL)
    ]);
    if (!Array.isArray(firstPage) || !validCount(merged?.total_count)) throw Error('GitHub response changed');

    let openTotal = 0;
    let openDrafts = 0;
    let page = 1;
    let rows = firstPage;
    while (true) {
      if (rows.some(pr => !pr || !validCount(pr.number) || typeof pr.draft !== 'boolean' || pr.state !== 'open')) {
        throw Error('GitHub pull request response changed');
      }
      openTotal += rows.length;
      openDrafts += rows.filter(pr => pr.draft).length;
      if (rows.length < 100) break;
      if (++page > MAX_PAGES) throw Error('GitHub pagination limit reached');
      rows = await getJSON(fetcher, openURL(page));
      if (!Array.isArray(rows)) throw Error('GitHub pagination response changed');
    }
    return {
      available: true,
      observedAt: new Date(observed).toISOString(),
      source: 'GitHub public MJobs PR API',
      openTotal, openDrafts,
      mergedSince: merged.total_count,
      sinceUTC,
      note: 'PR delivery is not canonical requirement acceptance or proof of running agents.'
    };
  }

  async function status() {
    if (pending) return pending;
    if (snapshot && clock() < expiresAt) return snapshot;
    pending = (async () => {
      try {
        snapshot = await collect();
        expiresAt = clock() + ttlMs;
      } catch {
        snapshot = {
          available: false,
          observedAt: new Date(clock()).toISOString(),
          reason: 'GitHub delivery data is unavailable; no counts are inferred.'
        };
        expiresAt = clock() + Math.min(ttlMs, 60000);
      } finally {
        pending = null;
      }
      return snapshot;
    })();
    return pending;
  }

  return { status };
}

module.exports = { createGitHubDelivery };
