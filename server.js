import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { solveQuiz } from './solver-llm.js';

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

const SERVER_SECRET = process.env.SECRET;
if (!SERVER_SECRET) {
  console.warn('⚠️  Warning: No SECRET set in .env file');
}

if (!process.env.AIPIPE_TOKEN && !process.env.GROQ_API_KEY) {
  console.warn('⚠️  Warning: No AI API keys found. Set AIPIPE_TOKEN or GROQ_API_KEY');
}

app.post('/task', async (req, res) => {
  if (!req.is('application/json')) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  if (!payload.secret || payload.secret !== SERVER_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  // Valid request - respond 200 immediately
  res.status(200).json({ received: true });

  console.log('\n' + '═'.repeat(70));
  console.log('📨 Received task request');
  console.log(`   Email: ${payload.email}`);
  console.log(`   URL: ${payload.url}`);
  console.log('═'.repeat(70));

  try {
    await solveQuiz(payload);
  } catch (err) {
    console.error('💥 Solver failed:', err);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🌟 Universal LLM Quiz Solver`);
  console.log(`   Listening on port ${port}`);
  console.log(`   Ready to solve any data science task!`);
  console.log('═'.repeat(70));
});