// server.js - Render-friendly server entry
// - listens on process.env.PORT
// - logs every request to stdout
// - health endpoint for quick checks
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { solveQuiz } from './solver-llm.js';

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// Simple request logger so Render logs show activity
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`[${now}] ${req.method} ${req.originalUrl} from ${req.ip}`);
  next();
});

const SERVER_SECRET = process.env.SECRET;
if (!SERVER_SECRET) {
  console.warn('⚠️  Warning: No SECRET set in environment (process.env.SECRET)');
}

// Basic health and root endpoints
app.get('/', (req, res) => {
  res.type('text').send('LLM Quiz Analysis - healthy\n');
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), env: process.env.NODE_ENV || 'undefined' });
});

// Task endpoint (keeps existing logic)
app.post('/task', async (req, res) => {
  if (!req.is('application/json')) {
    console.warn('Invalid content-type for /task');
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    console.warn('Invalid JSON payload for /task');
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  if (!payload.secret || payload.secret !== SERVER_SECRET) {
    console.warn('Invalid secret attempt for /task from', req.ip);
    return res.status(403).json({ error: 'Invalid secret' });
  }

  // Acknowledge immediately (so Render request doesn't time out)
  res.status(200).json({ received: true });

  console.log('='.repeat(70));
  console.log('📨 Received task request at', new Date().toISOString());
  console.log(`   Email: ${payload.email}`);
  console.log(`   URL: ${payload.url}`);
  console.log('='.repeat(70));

  try {
    await solveQuiz(payload);
  } catch (err) {
    console.error('💥 Solver failed:', err);
  }
});

// Use Render-provided PORT or default 7860
const PORT = parseInt(process.env.PORT || '7860', 10);

// MINIMAL EDIT HERE: Add '0.0.0.0' to explicitly bind to all interfaces
app.listen(PORT, '0.0.0.0', () => { 
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🌟 Universal LLM Quiz Solver`);
  console.log(`   Listening on port ${PORT}`);
  console.log(`   NODE_ENV=${process.env.NODE_ENV || 'undefined'}`);
  console.log(`   SECRET set? ${!!process.env.SECRET}`);
  console.log('   Make sure OPENAI/AIPIPE/GROQ/TRANSCRIBE keys are set in env for LLM/transcription');
  console.log(`${'═'.repeat(70)}\n`);
});
