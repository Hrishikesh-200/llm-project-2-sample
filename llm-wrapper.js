// llm-wrapper.js - Robust LLM calling with retry and voting
import axios from 'axios';

const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;

// Call OpenAI via AIPipe
async function callOpenAI(systemPrompt, userPrompt) {
  if (!process.env.AIPIPE_TOKEN) return null;

  try {
    const response = await axios.post(
      "https://aipipe.org/openai/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 4000,
        temperature: 0.1
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.AIPIPE_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 60000
      }
    );

    return response.data?.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.warn("  ✗ OpenAI failed:", error.message);
    return null;
  }
}

// Call Groq
async function callGroq(systemPrompt, userPrompt) {
  if (!process.env.GROQ_API_KEY) return null;
  
  try {
    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 4000,
      temperature: 0.1
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      timeout: 60000
    });

    return response.data?.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.warn('  ✗ Groq failed:', error.message);
    return null;
  }
}

// Main LLM caller with retry
export async function callLLM(systemPrompt, userPrompt, options = {}) {
  const { retries = MAX_RETRIES, preferredModel = 'openai' } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`  🔄 Retry ${attempt}/${retries}...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }

    // Try preferred model first
    let result;
    if (preferredModel === 'openai') {
      result = await callOpenAI(systemPrompt, userPrompt);
      if (result) return result;
      
      result = await callGroq(systemPrompt, userPrompt);
      if (result) return result;
    } else {
      result = await callGroq(systemPrompt, userPrompt);
      if (result) return result;
      
      result = await callOpenAI(systemPrompt, userPrompt);
      if (result) return result;
    }
  }

  throw new Error('All LLM attempts failed');
}

/**
 * Call multiple models and vote on best answer
 */
export async function callLLMWithVoting(systemPrompt, userPrompt) {
  console.log('  📊 Using voting mode...');
  
  const [openaiResult, groqResult] = await Promise.all([
    callOpenAI(systemPrompt, userPrompt),
    callGroq(systemPrompt, userPrompt)
  ]);

  const results = [openaiResult, groqResult].filter(r => r !== null);
  
  if (results.length === 0) {
    throw new Error('All models failed');
  }

  console.log(`  ✓ Got ${results.length} responses`);
  
  // For now, prefer OpenAI if available
  return openaiResult || groqResult;
}

/**
 * Ask LLM to verify/improve an answer
 */
export async function verifyAnswer(question, proposedAnswer, context) {
  const systemPrompt = 'You are a verification expert. Check if answers are correct and suggest improvements.';
  const userPrompt = `Question: ${question}

Proposed Answer: ${proposedAnswer}

Context: ${context}

Is this answer correct? If not, what should it be? Respond with:
CORRECT: yes/no
REASON: [explanation]
BETTER_ANSWER: [improved answer if wrong, or same if correct]`;

  try {
    const response = await callLLM(systemPrompt, userPrompt, { retries: 1 });
    
    const correctMatch = response.match(/CORRECT:\s*(yes|no)/i);
    const reasonMatch = response.match(/REASON:\s*(.+)/i);
    const betterMatch = response.match(/BETTER_ANSWER:\s*(.+)/i);
    
    return {
      isCorrect: correctMatch?.[1]?.toLowerCase() === 'yes',
      reason: reasonMatch?.[1]?.trim() || '',
      betterAnswer: betterMatch?.[1]?.trim() || proposedAnswer
    };
  } catch (error) {
    console.warn('Verification failed:', error.message);
    return { isCorrect: true, reason: '', betterAnswer: proposedAnswer };
  }
}