// solver-llm.js - Universal robust quiz solver with retry logic
import axios from 'axios';
import { chromium } from 'playwright';
import pdfParse from 'pdf-parse';
import { callLLM, verifyAnswer } from './llm-wrapper.js';
import { processCSV, analyzeCSV, extractPatterns, sumNumbersWithCondition } from './data-processor.js';
import { transcribeAudio, parseAudioInstructions } from './audio-transcriber.js';

const TIMEOUT_MS = 2.5 * 60 * 1000;
const PER_PAGE_TIMEOUT_MS = 60_000;
const MAX_RETRIES_PER_TASK = 3;

// Download file with retry
async function downloadFile(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await axios.get(url, { 
        responseType: 'arraybuffer',
        timeout: PER_PAGE_TIMEOUT_MS,
        maxContentLength: 50 * 1024 * 1024
      });
      return Buffer.from(resp.data);
    } catch (error) {
      if (i === retries) {
        console.error(`❌ Failed to download ${url}:`, error.message);
        throw error;
      }
      console.warn(`  Retry ${i+1}/${retries} for ${url}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Extract text from PDF
async function extractPdfText(buffer) {
  const data = await pdfParse(buffer);
  return data.text;
}

// Post answer with retry
async function postAnswer(submitUrl, payload, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await axios.post(submitUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: PER_PAGE_TIMEOUT_MS,
      });
      console.log('✅ Server response:', resp.data);
      return resp.data;
    } catch (err) {
      if (i === retries) {
        console.error('❌ Submission failed:', err?.response?.data || err.message);
        throw err;
      }
      console.warn(`  Retry ${i+1}/${retries} for submission`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Scrape page with browser
async function scrapePageWithBrowser(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: PER_PAGE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(500);
  return await page.evaluate(() => document.body.innerText || '');
}

// Discover files on page
async function discoverFiles(page, baseUrl) {
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => ({
      href: a.href,
      text: a.textContent?.trim() || ''
    }));
  });

  const files = {
    csv: [],
    pdf: [],
    audio: [],
    other: []
  };

  for (const link of links) {
    if (!link.href) continue;
    
    const url = link.href.toLowerCase();
    if (url.includes('.csv')) files.csv.push(link.href);
    else if (url.includes('.pdf')) files.pdf.push(link.href);
    else if (url.match(/\.(mp3|wav|opus|ogg|m4a|flac)/)) files.audio.push(link.href);
    else if (url.match(/\.(json|txt|xml)/)) files.other.push(link.href);
  }

  return files;
}

// Main intelligent solver
async function solveSinglePage(page, url, payload, attemptNumber = 1) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`🎯 Attempt ${attemptNumber} for this task`);
  console.log('─'.repeat(70));

  await page.goto(url, { waitUntil: 'networkidle', timeout: PER_PAGE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(500);

  const bodyText = await page.evaluate(() => document.body.innerText || '');
  const html = await page.content();
  
  console.log('📄 Page content (first 600 chars):\n', bodyText.slice(0, 600));

  // Step 1: Intelligent Analysis with LLM
  const systemPrompt = `You are an expert at analyzing data science tasks. Be precise and thorough.`;

  const analysisPrompt = `Analyze this data science task carefully:

URL: ${url}

PAGE CONTENT:
${bodyText.slice(0, 4000)}

Your job is to:
1. Identify what type of task this is (scraping, data analysis, computation, extraction, etc.)
2. Find ALL files that need to be downloaded (CSV, PDF, audio, JSON, etc.) - provide FULL URLs
3. Determine if any pages need to be scraped with JavaScript rendering
4. Identify any conditions, filters, or operations (e.g., "sum numbers below 30064", "extract secret code")
5. Find the submit URL

Respond in this EXACT format:
TASK_TYPE: [scraping/analysis/computation/extraction/visualization]
DESCRIPTION: [what needs to be done in one sentence]
FILES: [comma-separated full URLs, or "none"]
SCRAPE_URL: [full URL to scrape, or "none"]
OPERATION: [sum/filter/extract/count/average/etc.]
CONDITIONS: [any filters, cutoffs, or special requirements]
SUBMIT: [submit URL]

Be thorough - don't miss any file URLs or conditions!`;

  console.log('\n🤖 Step 1: Analyzing task with LLM...');
  const analysisResponse = await callLLM(systemPrompt, analysisPrompt);
  console.log('📋 Analysis:', analysisResponse.slice(0, 400));

  // Parse analysis
  const taskType = analysisResponse.match(/TASK_TYPE:\s*(.+)/i)?.[1]?.trim() || 'unknown';
  const description = analysisResponse.match(/DESCRIPTION:\s*(.+)/i)?.[1]?.trim() || '';
  const filesStr = analysisResponse.match(/FILES:\s*(.+)/i)?.[1]?.trim() || 'none';
  const scrapeUrl = analysisResponse.match(/SCRAPE_URL:\s*(.+)/i)?.[1]?.trim() || 'none';
  const operation = analysisResponse.match(/OPERATION:\s*(.+)/i)?.[1]?.trim() || '';
  const conditions = analysisResponse.match(/CONDITIONS:\s*(.+)/i)?.[1]?.trim() || '';
  const submitUrl = analysisResponse.match(/SUBMIT:\s*(.+)/i)?.[1]?.trim() || null;

  console.log('  Type:', taskType);
  console.log('  Operation:', operation);
  console.log('  Conditions:', conditions);

  // Step 2: Discover files on page
  const discoveredFiles = await discoverFiles(page, url);
  console.log('\n📦 Discovered files:', {
    csv: discoveredFiles.csv.length,
    pdf: discoveredFiles.pdf.length,
    audio: discoveredFiles.audio.length
  });

  // Step 3: Scrape if needed
  let scrapedText = '';
  if (scrapeUrl && scrapeUrl !== 'none' && !scrapeUrl.includes('none')) {
    try {
      const fullUrl = scrapeUrl.startsWith('http') ? scrapeUrl : new URL(scrapeUrl, url).toString();
      console.log('\n🌐 Scraping:', fullUrl);
      scrapedText = await scrapePageWithBrowser(page, fullUrl);
      console.log('  ✓ Scraped:', scrapedText.slice(0, 150));
    } catch (e) {
      console.warn('  ⚠️  Scrape failed:', e.message);
    }
  }

  // Step 4: Download and process files
  const downloadedFiles = {};
  
  // Combine LLM-identified and discovered files
  let allFileUrls = [];
  if (filesStr !== 'none') {
    allFileUrls = filesStr.split(',').map(f => f.trim()).filter(f => f && f.startsWith('http'));
  }
  allFileUrls = [...new Set([...allFileUrls, ...discoveredFiles.csv, ...discoveredFiles.pdf])];
  
  console.log('\n📥 Downloading files:', allFileUrls.length);

  for (const fileUrl of allFileUrls) {
    try {
      console.log(`  Downloading: ${fileUrl.split('/').pop()}`);
      const buffer = await downloadFile(fileUrl);
      
      let content = '';
      const fileName = fileUrl.toLowerCase();
      
      if (fileName.endsWith('.pdf')) {
        content = await extractPdfText(buffer);
        console.log(`    ✓ PDF extracted (${content.length} chars)`);
      } else if (fileName.endsWith('.csv')) {
        content = buffer.toString('utf8');
        console.log(`    ✓ CSV loaded (${content.length} chars)`);
        
        // Analyze CSV structure
        const csvInfo = analyzeCSV(content);
        console.log(`    Columns: ${csvInfo.columnCount}, Rows: ${csvInfo.rowCount}`);
      } else {
        content = buffer.toString('utf8');
        console.log(`    ✓ File loaded (${content.length} chars)`);
      }
      
      downloadedFiles[fileUrl] = content;
    } catch (e) {
      console.warn(`    ⚠️  Failed: ${e.message}`);
    }
  }

  // Step 5: Transcribe audio and get actual instructions!
  let audioInstructions = null;
  let audioTranscript = '';
  
  for (const [fileUrl, content] of Object.entries(downloadedFiles)) {
    if (fileUrl.match(/\.(opus|mp3|wav|ogg|m4a)/i)) {
      console.log(`\n🎵 Audio file detected: ${fileUrl.split('/').pop()}`);
      
      // Actually transcribe the audio!
      const buffer = Buffer.from(content, 'binary');
      audioTranscript = await transcribeAudio(buffer, fileUrl.split('/').pop());
      
      if (audioTranscript) {
        audioInstructions = parseAudioInstructions(audioTranscript);
        console.log(`\n✅ Audio transcribed successfully!`);
        console.log(`   Full transcript: "${audioTranscript}"`);
      } else {
        console.log(`   ⚠️  Transcription failed - will rely on LLM analysis`);
      }
    }
  }
  
  // Step 6: Process data with audio instructions
  let processedData = {};
  
  for (const [fileUrl, content] of Object.entries(downloadedFiles)) {
    if (fileUrl.toLowerCase().endsWith('.csv')) {
      console.log(`\n🔧 Processing CSV: ${fileUrl.split('/').pop()}`);
      
      let filterCondition = null;
      let targetColumn = null;
      
      // Use audio instructions if available
      if (audioInstructions && audioInstructions.filter) {
        filterCondition = audioInstructions.filter;
        console.log(`   Using audio instruction: ${filterCondition.operator} ${filterCondition.value}`);
      } else {
        // Fallback to page conditions
        const cutoffMatch = conditions.match(/\d+/);
        if (cutoffMatch) {
          // Default to >= if audio said "greater than or equal"
          filterCondition = { operator: '>=', value: parseInt(cutoffMatch[0]) };
          console.log(`   Using page condition: >= ${cutoffMatch[0]}`);
        }
      }
      
      // Use target column from audio if specified
      if (audioInstructions && audioInstructions.target === 'first_column') {
        targetColumn = 'col0';
        console.log(`   Target: first column only`);
      }
      
      const csvResult = await processCSV(content, { 
        filter: filterCondition,
        targetColumn: targetColumn
      });
      processedData[fileUrl] = csvResult;
      
      console.log(`   📊 CSV Result: Sum = ${csvResult.summary.sum}`);
    }
  }

  // Step 6: Ask LLM to compute answer
  const dataContext = Object.entries(downloadedFiles).map(([url, content]) => {
    const fileName = url.split('/').pop();
    if (fileName.endsWith('.csv')) {
      const data = processedData[url];
      return `CSV File: ${fileName}
Rows: ${data?.rowCount || 'unknown'}
Filtered Numbers (sample): ${data?.summary?.firstFew?.join(', ') || 'none'}
Sum of filtered numbers: ${data?.summary?.sum || 0}`;
    }
    return `File: ${fileName}\nContent: ${content.slice(0, 800)}`;
  }).join('\n\n---\n\n');

  const solvePrompt = `Solve this ${taskType} task:

TASK: ${description}
OPERATION: ${operation}
CONDITIONS: ${conditions}

${scrapedText ? `SCRAPED PAGE CONTENT:\n${scrapedText.slice(0, 1000)}\n\n` : ''}

${dataContext ? `DATA AVAILABLE:\n${dataContext}\n\n` : ''}

CRITICAL INSTRUCTIONS:
1. If you see "Secret code is X" → answer is X
2. If task says "sum numbers below/less than Y" → sum only numbers < Y (not >=)
3. For CSV with cutoff, the sum is already computed above - use that value
4. Return ONLY the final answer value (number or short text)
5. NO explanations, NO markdown, just the answer

What is the answer?`;

  console.log('\n🧠 Step 2: Computing answer with LLM...');
  const answerResponse = await callLLM(systemPrompt, solvePrompt);
  console.log('💡 LLM Answer:', answerResponse.slice(0, 200));

  // Extract clean answer
  let answer = answerResponse.trim();
  
  // Check if we have processed CSV data with sum
  const csvData = Object.values(processedData).find(d => d.summary?.sum !== undefined);
  if (csvData && conditions.toLowerCase().includes('cutoff')) {
    // Use computed sum from CSV processing
    console.log('  ℹ️  Using computed CSV sum instead of LLM answer');
    answer = csvData.summary.sum;
  } else {
    // Clean LLM response
    const lines = answer.split('\n').filter(l => l.trim());
    answer = lines[lines.length - 1]?.trim() || answer;
    answer = answer.replace(/^(Answer:|Final Answer:|Result:)\s*/i, '').trim();
    answer = answer.replace(/[`'"]/g, '').trim();
    
    // Try to parse as number
    if (/^\d+$/.test(answer)) {
      answer = parseInt(answer, 10);
    } else if (/^\d+\.\d+$/.test(answer)) {
      answer = parseFloat(answer);
    }
  }

  // Determine submit URL
  let finalSubmitUrl = submitUrl;
  if (!finalSubmitUrl || finalSubmitUrl === 'null' || finalSubmitUrl === 'none' || !finalSubmitUrl.startsWith('http')) {
    const match = bodyText.match(/(https?:\/\/[^\s]+\/submit[^\s]*)/i) ||
                  bodyText.match(/POST\s+(?:to\s+)?([^\s]+\/submit[^\s]*)/i);
    if (match) {
      finalSubmitUrl = match[1].startsWith('http') ? match[1] : new URL(match[1], url).toString();
    } else {
      finalSubmitUrl = new URL('/submit', url).toString();
    }
  }

  console.log('\n✅ Final Answer:', answer);
  console.log('📮 Submit URL:', finalSubmitUrl);

  return { submitUrl: finalSubmitUrl, answer };
}

// Main quiz solver with retry logic
export async function solveQuiz(initialPayload) {
  const start = Date.now();
  let currentUrl = initialPayload.url;
  
  if (!currentUrl) {
    console.error('❌ No URL provided');
    return;
  }

  console.log('\n' + '═'.repeat(70));
  console.log('🚀 UNIVERSAL LLM-POWERED QUIZ SOLVER');
  console.log('   Adaptive • Intelligent • Robust');
  console.log('═'.repeat(70));

  const browser = await chromium.launch({ 
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  });
  const page = await browser.newPage();

  try {
    let taskCount = 0;
    const taskHistory = [];

    while (currentUrl && Date.now() - start < TIMEOUT_MS && taskCount < 20) {
      taskCount += 1;
      const remainingTime = Math.round((TIMEOUT_MS - (Date.now() - start)) / 1000);
      
      console.log(`\n${'═'.repeat(70)}`);
      console.log(`📍 TASK ${taskCount} | ⏱️  ${remainingTime}s remaining`);
      console.log(`🔗 ${currentUrl}`);
      console.log('═'.repeat(70));

      let submitSuccess = false;
      let lastAnswer = null;
      let lastSubmitUrl = null;

      // Try up to MAX_RETRIES_PER_TASK times for this task (but stop if getting same wrong answer)
      let previousAnswers = [];
      for (let attempt = 1; attempt <= MAX_RETRIES_PER_TASK && !submitSuccess; attempt++) {
        try {
          const { submitUrl, answer } = await solveSinglePage(page, currentUrl, initialPayload, attempt);
          lastAnswer = answer;
          lastSubmitUrl = submitUrl;

          const submitPayload = {
            email: initialPayload.email,
            secret: initialPayload.secret,
            url: currentUrl,
            answer
          };

          console.log(`\n📤 Submitting attempt ${attempt}:`, { ...submitPayload, secret: '***', answer });

          let submitResp = null;
          try {
            submitResp = await postAnswer(submitUrl, submitPayload);
          } catch (postErr) {
            console.error('❌ Submission error:', postErr.message);
            
            // Try fallback URL
            try {
              const fallbackUrl = new URL('/submit', currentUrl).toString();
              console.log('🔄 Trying fallback:', fallbackUrl);
              submitResp = await postAnswer(fallbackUrl, submitPayload);
            } catch (fallbackErr) {
              console.error('❌ Fallback failed');
              if (attempt === MAX_RETRIES_PER_TASK) throw fallbackErr;
              continue;
            }
          }

          // Check response
          if (submitResp?.correct === true) {
            console.log('✅ CORRECT!');
            submitSuccess = true;
            taskHistory.push({ url: currentUrl, answer, correct: true });
            
            if (submitResp.url) {
              currentUrl = submitResp.url;
              initialPayload.url = currentUrl;
            } else {
              console.log('\n' + '═'.repeat(70));
              console.log('🎉 QUIZ COMPLETED SUCCESSFULLY!');
              console.log('═'.repeat(70));
              currentUrl = null;
            }
            break;
          } else {
            console.warn(`⚠️  Attempt ${attempt} incorrect:`, submitResp?.reason || 'Unknown reason');
            taskHistory.push({ url: currentUrl, answer, correct: false, reason: submitResp?.reason });
            
            // Check if we're getting the same wrong answer repeatedly
            if (previousAnswers.includes(JSON.stringify(answer))) {
              console.log('⚠️  Same answer as before - this approach is not working');
              
              // If server gives next URL, move on instead of wasting time
              if (submitResp?.url) {
                console.log('⏭️  Moving to next task (avoiding infinite loop)');
                currentUrl = submitResp.url;
                initialPayload.url = currentUrl;
                break;
              } else {
                console.log('❌ No next URL provided and approach not working - stopping');
                currentUrl = null;
                break;
              }
            }
            
            previousAnswers.push(JSON.stringify(answer));
            
            // If server gives us next URL even on wrong answer, we can choose to continue
            if (submitResp?.url && attempt === MAX_RETRIES_PER_TASK) {
              console.log('⏭️  Moving to next task (max retries reached)');
              currentUrl = submitResp.url;
              initialPayload.url = currentUrl;
              break;
            }
            
            // Wait before retry
            if (attempt < MAX_RETRIES_PER_TASK) {
              console.log(`   Retrying in 2s...`);
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        } catch (error) {
          console.error(`❌ Attempt ${attempt} failed:`, error.message);
          if (attempt === MAX_RETRIES_PER_TASK) {
            console.error('💥 Max retries reached for this task');
            currentUrl = null;
            break;
          }
        }
      }

      if (!submitSuccess && !currentUrl) {
        break;
      }

      await page.waitForTimeout(500);
    }

    await browser.close();
    
    const totalTime = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📊 SUMMARY`);
    console.log(`   Total tasks: ${taskCount}`);
    console.log(`   Successful: ${taskHistory.filter(t => t.correct).length}`);
    console.log(`   Time: ${totalTime}s`);
    console.log('═'.repeat(70));
    
  } catch (err) {
    try { await browser.close(); } catch (e) {}
    console.error('💥 Fatal error:', err);
  }
}