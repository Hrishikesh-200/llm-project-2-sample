{
  "name": "llm-quiz-analysis",
  "version": "0.1.0",
  "description": "Universal LLM-powered quiz solver",
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "postinstall": "npx playwright install --with-deps chromium"
  },
  "dependencies": {
    "axios": "^1.13.2",
    "body-parser": "^1.20.2",
    "csv-parser": "^3.2.0",
    "dotenv": "^16.1.4",
    "express": "^4.18.2",
    "form-data": "^4.0.5",
    "pdf-parse": "^1.1.4",
    "playwright": "^1.56.1"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}

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

const port = process.env.PORT || 7860; // Hugging Face uses 7860
app.listen(port, '0.0.0.0', () => {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🌟 Universal LLM Quiz Solver`);
  console.log(`   Listening on port ${port}`);
  console.log(`   NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  console.log(`   SECRET set? ${!!SERVER_SECRET}`);
  console.log(`   Make sure OPENAI/AIPIPE/GROQ/TRANSCRIBE keys are set in env for LLM/transcription`);
  console.log('═'.repeat(70) + '\n');
});
