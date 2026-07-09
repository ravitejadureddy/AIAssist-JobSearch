// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workday provider — hits the public Workday CXS jobs API.
// Supports any company whose careers_url points to a myworkdayjobs.com domain.
//
// URL format:  https://{tenant}.wd{N}.myworkdayjobs.com/{board}
// API format:  POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{board}/jobs
// Auth:        none — public endpoint, no key required

const WORKDAY_HOST_RE = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i;
const PAGE_SIZE = 20;
const MAX_JOBS = 300; // safety cap — avoids runaway pagination on large companies

function parseConfig(careersUrl = '') {
  let parsed;
  try { parsed = new URL(careersUrl); } catch { return null; }

  const hostMatch = parsed.hostname.match(WORKDAY_HOST_RE);
  if (!hostMatch) return null;

  const tenant = hostMatch[1];
  const wd = hostMatch[2];
  // Board name is the first non-empty path segment
  const board = parsed.pathname.split('/').find(s => s.length > 0);
  if (!board) return null;

  return {
    tenant,
    wd,
    board,
    apiUrl: `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${board}/jobs`,
    baseUrl: `https://${tenant}.${wd}.myworkdayjobs.com/${board}`,
  };
}

/** @type {Provider} */
export default {
  id: 'workday',

  detect(entry) {
    const config = parseConfig(entry.careers_url);
    return config ? { url: config.apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const config = parseConfig(entry.careers_url);
    if (!config) throw new Error(`workday: cannot derive API URL for ${entry.name}`);

    const allJobs = [];
    let offset = 0;

    while (allJobs.length < MAX_JOBS) {
      const json = await ctx.fetchJson(config.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // "data" catches data engineer, data analyst, data platform, etc.
        // scan.mjs title_filter narrows to the exact titles we want.
        body: JSON.stringify({
          appliedFacets: {},
          limit: PAGE_SIZE,
          offset,
          searchText: 'data',
        }),
      });

      const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
      if (postings.length === 0) break;

      for (const j of postings) {
        if (!j.externalPath) continue;
        allJobs.push({
          title: j.title || '',
          url: `${config.baseUrl}${j.externalPath}`,
          company: entry.name,
          location: j.locationsText || '',
        });
      }

      // Stop when we've seen all results or hit the last page
      const total = typeof json.total === 'number' ? json.total : 0;
      if (postings.length < PAGE_SIZE || offset + PAGE_SIZE >= total) break;
      offset += PAGE_SIZE;
    }

    return allJobs;
  },
};
