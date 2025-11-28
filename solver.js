// solver.js - UPDATED with scrape handling, cutoff logic, and improved audio detection
import axios from 'axios';
import csvParser from 'csv-parser';
import pdfParse from 'pdf-parse';
import { chromium } from 'playwright';
import { Readable } from 'stream';
import { handleCsvAudioAndSum } from './audio-helper.js';

const TIMEOUT_MS = 2.5 * 60 * 1000; // 2.5 minutes timeout for the solve process
const PER_PAGE_TIMEOUT_MS = 60_000;

async function downloadBuffer(url, headers = {}) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', headers, timeout: PER_PAGE_TIMEOUT_MS });
  return Buffer.from(resp.data);
}

// Improved sumCsvColumnEnhanced: detects headerless CSVs and handles numeric parsing robustly
async function sumCsvColumnEnhanced(buffer, cutoff = null) {
  return new Promise((resolve, reject) => {
    // If the first line looks like numeric data (most columns numeric), prepend synthetic headers
    try {
      const text = buffer.toString('utf8');
      const firstLine = text.split(/\r?\n/)[0] || '';
      const firstCols = firstLine.split(',');
      const numericCols = firstCols.filter(c => /^\s*-?\d+(\.\d+)?\s*$/.test(c)).length;
      if (firstCols.length > 0 && (numericCols / firstCols.length) > 0.6) {
        // create synthetic header and rebuild buffer
        const synthHeader = firstCols.map((_, i) => `col${i+1}`).join(',');
        const newText = synthHeader + '\n' + text;
        buffer = Buffer.from(newText, 'utf8');
        console.log('sumCsvColumnEnhanced: detected headerless CSV — prepended synthetic header');
      }
    } catch (e) {
      // if anything goes wrong, continue with original buffer
      console.warn('sumCsvColumnEnhanced: header-detection failed, proceeding normally:', e?.message || e);
    }

    const stream = Readable.from(buffer);
    const parser = csvParser();
    const numericCounts = {};     // count of numeric values per column
    const totalCounts = {};       // total non-empty values per column
    const sums = {};              // running sum per column
    let headerColumns = null;
    let rowCount = 0;

    // Prioritize columns whose headers match these tokens (higher weight)
    const headerPriorityRegex = /\b(value|amount|price|total|sum|count|qty|quantity|score|points|number)\b/i;

    function cleanNumberString(s) {
      if (s === null || s === undefined) return null;
      let t = String(s).trim();
      if (t === '') return null;
      const paren = /^\((.*)\)$/.exec(t);
      if (paren) t = '-' + paren[1];
      t = t.replace(/[$€£¥₹\s]/g, '');
      t = t.replace(/,/g, '');
      t = t.replace(/%/g, '');
      t = t.replace(/^"(.+)"$/, '$1');
      t = t.replace(/[^0-9.\-+eE]/g, '');
      if (t === '' || t === '.' || t === '-' || t === '+') return null;
      const v = Number(t);
      if (Number.isFinite(v)) return v;
      return null;
    }

    parser.on('headers', (headers) => {
      headerColumns = headers;
      headers.forEach(h => { numericCounts[h] = 0; totalCounts[h] = 0; sums[h] = 0; });
    });

    parser.on('data', (row) => {
      rowCount += 1;
      if (!headerColumns) headerColumns = Object.keys(row);
      for (const col of Object.keys(row)) {
        const raw = row[col];
        if (raw === undefined || raw === null || String(raw).trim() === '') continue;
        totalCounts[col] = (totalCounts[col] || 0) + 1;
        const v = cleanNumberString(raw);
        if (v !== null && !Number.isNaN(v)) {
          // Apply cutoff filter if specified
          if (cutoff === null || v < cutoff) {
            numericCounts[col] = (numericCounts[col] || 0) + 1;
            sums[col] = (sums[col] || 0) + v;
          }
        }
      }
    });

    parser.on('end', () => {
      const cols = Object.keys(totalCounts);
      if (cols.length === 0) {
        const txt = buffer.toString('utf8');
        const matches = txt.match(/-?\d+(?:\.\d+)?/g);
        if (!matches) return resolve(0);
        let numbers = matches.map(Number);
        if (cutoff !== null) numbers = numbers.filter(n => n < cutoff);
        return resolve(numbers.reduce((a,b)=>a+b,0));
      }

      const scored = cols.map(col => {
        const numericHits = numericCounts[col] || 0;
        const total = totalCounts[col] || 0;
        const hitRatio = total > 0 ? numericHits / total : 0;
        const headerPriority = headerPriorityRegex.test(col) ? 1 : 0;
        const score = headerPriority * 1000 + hitRatio * 100 + numericHits;
        return { col, numericHits, total, hitRatio, headerPriority, score, sum: sums[col] || 0 };
      });

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];

      console.log('sumCsvColumnEnhanced: column stats:', scored.slice(0,6));

      if (best && best.numericHits > 0) {
        return resolve(best.sum);
      }

      const txt = buffer.toString('utf8');
      const matches = txt.match(/-?\d+(?:\.\d+)?/g);
      if (!matches) return resolve(0);
      let numbers = matches.map(Number);
      if (cutoff !== null) numbers = numbers.filter(n => n < cutoff);
      return resolve(numbers.reduce((a,b)=>a+b,0));
    });

    parser.on('error', (err) => reject(err));
    stream.pipe(parser);
  });
}

async function sumNumbersInText(text, cutoff = null) {
  const matches = text.match(/-?\d+(\.\d+)?/g);
  if (!matches) return 0;
  let numbers = matches.map(Number);
  if (cutoff !== null) numbers = numbers.filter(n => n < cutoff);
  return numbers.reduce((a, b) => a + b, 0);
}

function extractFirstUrl(text) {
  const m = text.match(/https?:\/\/[^\s'"]+/);
  return m ? m[0].replace(/[.,\)\]]+$/, '') : null;
}

async function postAnswer(submitUrl, payload) {
  try {
    const resp = await axios.post(submitUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: PER_PAGE_TIMEOUT_MS,
    });
    console.log('Submitted answer, server responded:', resp.data);
    return resp.data;
  } catch (err) {
    console.error('Error posting answer to', submitUrl, err?.response?.data || err.message);
    throw err;
  }
}

async function tryParseJsonFromHtml(html) {
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (preMatch) {
    const text = preMatch[1].trim();
    try { return JSON.parse(text); } catch {}
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch {}
  }
  const jsonLikeMatches = html.match(/\{[\s\S]{10,10000}\}/);
  if (jsonLikeMatches) {
    try { return JSON.parse(jsonLikeMatches[0]); } catch {}
  }
  const answerLine = html.match(/"answer"\s*:\s*"([^"]{1,200})"/i);
  if (answerLine) return { exampleAnswer: answerLine[1] };
  return null;
}

function ensureNonEmptyAnswer(answer, fallback = 'submitted') {
  if (answer === null || answer === undefined) return fallback;
  if (typeof answer === 'string' && answer.trim() === '') return fallback;
  if (typeof answer === 'number' && answer === 0) return '0';
  return answer;
}

function normalizeUrlCandidate(candidate, pageUrl) {
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (/this\s+page('?s)?\s+url/i.test(trimmed) || /^this\s+page$/i.test(trimmed)) return pageUrl;
  if (/^https?:\/\//i.test(trimmed)) {
    try { return new URL(trimmed).toString(); } catch { return null; }
  }
  try { return new URL(trimmed, pageUrl).toString(); } catch { return null; }
}

function extractSubmitCandidateFromText(text) {
  const m = text.match(/POST\s+(?:the\s+answer\s+back\s+)?(?:to\s+)?(\/[^\s'"]+|https?:\/\/[^\s'"]+)/i);
  if (m) return m[1];
  const s = text.match(/(\/[a-z0-9_\-\/\?\=&]+submit[^\s'"]*)/i);
  if (s) return s[1];
  const p1 = text.match(/Post your answer to\s*(:|at)?\s*(https?:\/\/[^\s]+)/i);
  if (p1) return p1[2] || p1[1];
  return null;
}

function extractScrapePathFromText(text) {
  // Improved: handle "Scrape /path" or "Scrape path" patterns
  const m = text.match(/Scrape\s+(\/[^\s()]+)/i);
  if (m) return m[1];
  const m2 = text.match(/Scrape\s+([^\s()]+)\s*\(/i);
  if (m2) return m2[1];
  const m3 = text.match(/Scrape\s+([^\s.]+)/i);
  if (m3 && m3[1].startsWith('/')) return m3[1];
  return null;
}

function extractCutoffFromText(text) {
  const m = text.match(/Cutoff:\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function extractLikelySecretFromText(text) {
  if (!text) return null;
  const numeric = text.match(/\b(\d{3,})\b/);
  if (numeric) return numeric[1];
  let m = text.match(/secret\s*code\s*[:=]\s*([A-Za-z0-9\-_]{4,})/i);
  if (m) return m[1];
  m = text.match(/code\s*[:=]\s*([A-Za-z0-9\-_]{4,})/i);
  if (m) return m[1];
  m = text.match(/([A-Za-z0-9\-_]{4,})/);
  return m ? m[1] : null;
}

async function extractResourcesFromDOM(page, pageUrl) {
  const resources = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a')).map(a => ({ href: a.getAttribute('href'), text: a.innerText || '' }));
    const audios = Array.from(document.querySelectorAll('audio')).map(a => ({ src: a.getAttribute('src') }));
    const bodyText = document.body.innerText || '';
    return { anchors, audios, bodyText };
  });

  const csvUrls = [];
  const audioUrls = [];
  const submitCandidates = [];

  for (const a of resources.anchors) {
    if (!a.href) continue;
    const abs = normalizeUrlCandidate(a.href, pageUrl);
    if (!abs) continue;
    if (abs.toLowerCase().endsWith('.csv') || (a.text && /csv/i.test(a.text))) csvUrls.push(abs);
    else if (abs.toLowerCase().match(/\.(mp3|wav|ogg|opus|m4a|flac)(\?|$)/i)) audioUrls.push(abs);
    else if (/\/submit/i.test(abs) || /\/submit\b/i.test(a.href)) submitCandidates.push(abs);
  }

  for (const au of resources.audios) {
    if (!au.src) continue;
    const abs = normalizeUrlCandidate(au.src, pageUrl);
    if (abs) audioUrls.push(abs);
  }

  const firstHttp = resources.bodyText && resources.bodyText.match(/https?:\/\/[^\s'"]+/g);
  if (firstHttp) {
    for (const u of firstHttp) {
      const abs = normalizeUrlCandidate(u, pageUrl);
      if (!abs) continue;
      if (abs.toLowerCase().endsWith('.csv')) csvUrls.push(abs);
      if (abs.toLowerCase().includes('/submit')) submitCandidates.push(abs);
    }
  }

  return { csvUrls: Array.from(new Set(csvUrls)), audioUrls: Array.from(new Set(audioUrls)), submitCandidates: Array.from(new Set(submitCandidates)), bodyText: resources.bodyText };
}

async function solveSinglePage(page, url, payload) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: PER_PAGE_TIMEOUT_MS }).catch(()=>{});
  await page.waitForTimeout(300);

  const html = await page.content();
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  console.log('Page text (snippet):', bodyText.slice(0, 400));

  // Extract cutoff if present
  const cutoff = extractCutoffFromText(bodyText);
  if (cutoff !== null) {
    console.log('Found cutoff value:', cutoff);
  }

  // Check for scrape instruction
  const scrapePath = extractScrapePathFromText(bodyText);
  if (scrapePath) {
    const scrapeUrl = normalizeUrlCandidate(scrapePath, url);
    console.log('Found scrape instruction, fetching:', scrapeUrl);
    try {
      await page.goto(scrapeUrl, { waitUntil: 'networkidle', timeout: PER_PAGE_TIMEOUT_MS }).catch(()=>{});
      await page.waitForTimeout(300);
      const scrapedText = await page.evaluate(() => document.body.innerText || '');
      console.log('Scraped page content (snippet):', scrapedText.slice(0, 500));
      
      // Extract secret from scraped page
      const secret = extractLikelySecretFromText(scrapedText);
      if (secret) {
        console.log('Extracted secret from scraped page:', secret);
        
        // Determine submit URL
        const { submitCandidates } = await extractResourcesFromDOM(page, url);
        let submitUrl = submitCandidates.length > 0 ? submitCandidates[0] : null;
        if (!submitUrl) {
          try { submitUrl = new URL('/submit', url).toString(); } catch {}
        }
        
        return { submitUrl, answer: secret, rawPageText: scrapedText, html };
      }
    } catch (e) {
      console.warn('Failed to scrape path:', e?.message || e);
    }
    
    // Go back to original page if scraping failed
    await page.goto(url, { waitUntil: 'networkidle', timeout: PER_PAGE_TIMEOUT_MS }).catch(()=>{});
    await page.waitForTimeout(300);
  }

  let jsonObj = null;
  try {
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (preMatch) {
      const text = preMatch[1].trim();
      try { jsonObj = JSON.parse(text); } catch {
        try { jsonObj = JSON.parse(Buffer.from(text, 'base64').toString('utf8')); } catch {}
      }
    }
    if (!jsonObj) {
      const jsonLike = html.match(/\{[\s\S]{10,10000}\}/);
      if (jsonLike) {
        try { jsonObj = JSON.parse(jsonLike[0]); } catch {}
      }
    }
  } catch (e) {}

  if (jsonObj) console.log('Found JSON-like content on page:', jsonObj);

  const { csvUrls, audioUrls, submitCandidates, bodyText: domBody } = await extractResourcesFromDOM(page, url);
  console.log('DOM resources found: csvUrls=', csvUrls, 'audioUrls=', audioUrls, 'submitCandidates=', submitCandidates);

  let submitUrl = null;
  if (submitCandidates && submitCandidates.length > 0) submitUrl = submitCandidates[0];
  if (!submitUrl && jsonObj && (jsonObj.submit || jsonObj.url)) submitUrl = normalizeUrlCandidate(jsonObj.submit || jsonObj.url, url);
  if (!submitUrl) {
    const firstHttp = (domBody || bodyText).match(/https?:\/\/[^\s'"]+/);
    if (firstHttp) submitUrl = normalizeUrlCandidate(firstHttp[0], url);
  }
  if (!submitUrl) {
    try { submitUrl = new URL('/submit', url).toString(); } catch {}
  }
  console.log('Determined submit URL:', submitUrl);

  let answer = null;

  // Priority 1: If there are audio URLs on the page, process them first
  if (audioUrls && audioUrls.length > 0) {
    const audioUrl = audioUrls[0];
    console.log('Processing audio directly at', audioUrl);
    try {
      const csvText = `audio_url\n${audioUrl}\n`;
      const csvBuf = Buffer.from(csvText, 'utf8');
      const audioResult = await handleCsvAudioAndSum(csvBuf, url, page, cutoff);
      console.log('Audio helper result summary (direct audio): numbers=', audioResult.numbers, 'sum=', audioResult.sum);
      if (audioResult && Array.isArray(audioResult.numbers) && audioResult.numbers.length > 0) {
        answer = audioResult.sum;
      } else if (audioResult && typeof audioResult.sum === 'number' && audioResult.sum !== 0) {
        answer = audioResult.sum;
      } else {
        console.log('Audio returned no numbers; trying CSV if available');
        if (csvUrls && csvUrls.length > 0) {
          const buf = await downloadBuffer(csvUrls[0]);
          answer = await sumCsvColumnEnhanced(buf, cutoff);
        } else {
          answer = await sumNumbersInText(bodyText, cutoff);
        }
      }
    } catch (e) {
      console.warn('Failed to download/process audio:', e?.message || e);
      if (csvUrls && csvUrls.length > 0) {
        const buf = await downloadBuffer(csvUrls[0]);
        answer = await sumCsvColumnEnhanced(buf, cutoff);
      } else {
        answer = await sumNumbersInText(bodyText, cutoff);
      }
    }
  } else if (csvUrls && csvUrls.length > 0) {
    const fileUrl = csvUrls[0];
    console.log('Processing CSV at', fileUrl);
    try {
      const buf = await downloadBuffer(fileUrl);
      try {
        const audioResult = await handleCsvAudioAndSum(buf, fileUrl, page, cutoff);
        console.log('Audio helper result summary: numbers=', audioResult.numbers, 'sum=', audioResult.sum);
        console.log('Audio transcript snippet:', (audioResult.transcriptText || '').slice(0,300).replace(/\n/g,'\\n'));
        
        if (audioResult && Array.isArray(audioResult.numbers) && audioResult.numbers.length > 0) {
          answer = audioResult.sum;
        } else if (audioResult && typeof audioResult.sum === 'number' && audioResult.sum !== 0) {
          answer = audioResult.sum;
        } else {
          console.log('Audio helper returned no numbers; falling back to CSV numeric summing.');
          answer = await sumCsvColumnEnhanced(buf, cutoff);
        }
      } catch (e) {
        console.warn('Audio processing failed, falling back to CSV sum:', e?.message || e);
        answer = await sumCsvColumnEnhanced(buf, cutoff);
      }
    } catch (e) {
      console.warn('Failed to download/process CSV:', e?.message || e);
    }
  } else {
    if (jsonObj && jsonObj.url) {
      const fileUrl = normalizeUrlCandidate(jsonObj.url, url);
      if (fileUrl) {
        console.log('Found file URL in JSON (normalized):', fileUrl);
        try {
          const buf = await downloadBuffer(fileUrl);
          if (fileUrl.toLowerCase().endsWith('.csv')) {
            try {
              const audioResult = await handleCsvAudioAndSum(buf, fileUrl, page, cutoff);
              console.log('Audio helper result summary: numbers=', audioResult.numbers, 'sum=', audioResult.sum);
              if (audioResult && Array.isArray(audioResult.numbers) && audioResult.numbers.length > 0) {
                answer = audioResult.sum;
              } else if (audioResult && typeof audioResult.sum === 'number' && audioResult.sum !== 0) {
                answer = audioResult.sum;
              } else {
                answer = await sumCsvColumnEnhanced(buf, cutoff);
              }
            } catch (e) {
              answer = await sumCsvColumnEnhanced(buf, cutoff);
            }
          } else if (fileUrl.toLowerCase().endsWith('.pdf')) {
            const data = await pdfParse(buf);
            answer = await sumNumbersInText(data.text || '', cutoff);
          } else {
            answer = await sumCsvColumnEnhanced(buf, cutoff).catch(async () => sumNumbersInText(buf.toString('utf8'), cutoff));
          }
        } catch (e) {
          console.warn('Failed to download/process fileUrl:', e?.message || e);
        }
      }
    }
  }

  if (answer === null) answer = await sumNumbersInText(bodyText, cutoff);

  answer = ensureNonEmptyAnswer(answer, 'anything');
  return { submitUrl, answer, rawPageText: bodyText, html };
}

export async function solveQuiz(initialPayload) {
  const start = Date.now();
  let currentUrl = initialPayload.url;
  if (!currentUrl) {
    console.error('No url provided in payload');
    return;
  }
  console.log('Solving quiz starting at:', currentUrl);

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  const overallGuard = setTimeout(async () => {
    console.error('Solver overall timed out, closing browser.');
    try { await browser.close(); } catch (e) {}
  }, TIMEOUT_MS + 1000);

  try {
    let loopCount = 0;
    while (currentUrl && Date.now() - start < TIMEOUT_MS && loopCount < 20) {
      loopCount += 1;
      console.log(`Visiting URL (loop ${loopCount}), remainingTime=${Math.round((TIMEOUT_MS - (Date.now()-start))/1000)}s:`, currentUrl);

      const { submitUrl, answer } = await solveSinglePage(page, currentUrl, initialPayload);

      if (!submitUrl) {
        console.warn('No valid submit URL found on page, stopping.');
        break;
      }

      const submitPayload = {
        email: initialPayload.email,
        secret: initialPayload.secret,
        url: currentUrl,
        answer,
      };

      console.log('Posting payload to submitUrl:', submitUrl, 'with answer:', answer);

      let submitResp = null;
      try {
        submitResp = await postAnswer(submitUrl, submitPayload);
      } catch (postErr) {
        console.error('Failed to post answer:', postErr?.message || postErr);
        try {
          const hostSubmit = new URL('/submit', currentUrl).toString();
          console.log('Attempting fallback submit to host /submit:', hostSubmit);
          submitResp = await postAnswer(hostSubmit, submitPayload);
        } catch (fallbackErr) {
          console.error('Fallback submit failed:', fallbackErr?.message || fallbackErr);
          break;
        }
      }

      if (submitResp && submitResp.url) {
        currentUrl = submitResp.url;
        initialPayload.url = currentUrl;
        await page.waitForTimeout(300);
        continue;
      } else {
        console.log('No next URL returned, finished quiz flow.');
        break;
      }
    }

    clearTimeout(overallGuard);
    await browser.close();
    console.log(`Solver finished in ${((Date.now() - start)/1000).toFixed(1)}s`);
  } catch (err) {
    try { await browser.close(); } catch (e) {}
    console.error('Error in solver loop:', err);
  }
}