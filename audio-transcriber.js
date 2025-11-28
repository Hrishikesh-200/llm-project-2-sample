// audio-transcriber.js - Audio transcription using OpenAI Whisper API
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { spawnSync } from 'child_process';

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);

/**
 * Convert audio to WAV format for better compatibility
 */
function convertToWav(inputPath, outputPath) {
  const args = ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath];
  const result = spawnSync('ffmpeg', args, { stdio: 'ignore', timeout: 60000 });
  
  if (result.error) {
    throw new Error(`ffmpeg not found: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg conversion failed with status ${result.status}`);
  }
  
  return outputPath;
}

/**
 * Transcribe audio file using OpenAI Whisper or AIPipe
 */
export async function transcribeAudio(audioBuffer, fileName = 'audio.opus') {
  console.log(`\n🎙️  Transcribing audio: ${fileName}`);
  
  // Save buffer to temp file
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `input_${Date.now()}_${fileName}`);
  const wavPath = path.join(tmpDir, `converted_${Date.now()}.wav`);
  
  try {
    await writeFile(inputPath, audioBuffer);
    console.log(`   Saved to: ${inputPath}`);
    
    // Convert to WAV if not already
    let fileToTranscribe = inputPath;
    if (!fileName.endsWith('.wav')) {
      try {
        console.log(`   Converting to WAV...`);
        convertToWav(inputPath, wavPath);
        fileToTranscribe = wavPath;
        console.log(`   ✓ Converted to WAV`);
      } catch (convErr) {
        console.warn(`   ⚠️  Conversion failed, using original: ${convErr.message}`);
        fileToTranscribe = inputPath;
      }
    }
    
    // Try OpenAI Whisper via standard API
    if (process.env.OPENAI_API_KEY) {
      try {
        console.log(`   Using OpenAI Whisper API...`);
        const form = new FormData();
        form.append('file', fs.createReadStream(fileToTranscribe), {
          filename: path.basename(fileToTranscribe)
        });
        form.append('model', 'whisper-1');
        
        const response = await axios.post(
          'https://api.openai.com/v1/audio/transcriptions',
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          }
        );
        
        const transcript = response.data?.text || '';
        console.log(`   ✓ Transcribed (${transcript.length} chars)`);
        console.log(`   📝 "${transcript.slice(0, 150)}..."`);
        
        return transcript;
      } catch (apiErr) {
        console.warn(`   ⚠️  OpenAI API failed: ${apiErr.message}`);
      }
    }
    
    // Try AIPipe Whisper endpoint
    if (process.env.AIPIPE_TOKEN) {
      try {
        console.log(`   Using AIPipe Whisper API...`);
        const form = new FormData();
        form.append('file', fs.createReadStream(fileToTranscribe), {
          filename: path.basename(fileToTranscribe)
        });
        form.append('model', 'whisper-1');
        
        const response = await axios.post(
          'https://aipipe.org/openai/v1/audio/transcriptions',
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Authorization': `Bearer ${process.env.AIPIPE_TOKEN}`
            },
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          }
        );
        
        const transcript = response.data?.text || '';
        console.log(`   ✓ Transcribed (${transcript.length} chars)`);
        console.log(`   📝 "${transcript.slice(0, 150)}..."`);
        
        return transcript;
      } catch (aipipeErr) {
        console.warn(`   ⚠️  AIPipe failed: ${aipipeErr.message}`);
      }
    }
    
    // Try Groq Whisper (if available)
    if (process.env.GROQ_API_KEY) {
      try {
        console.log(`   Using Groq Whisper API...`);
        const form = new FormData();
        form.append('file', fs.createReadStream(fileToTranscribe), {
          filename: path.basename(fileToTranscribe)
        });
        form.append('model', 'whisper-large-v3');
        
        const response = await axios.post(
          'https://api.groq.com/openai/v1/audio/transcriptions',
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            timeout: 120000
          }
        );
        
        const transcript = response.data?.text || '';
        console.log(`   ✓ Transcribed (${transcript.length} chars)`);
        console.log(`   📝 "${transcript.slice(0, 150)}..."`);
        
        return transcript;
      } catch (groqErr) {
        console.warn(`   ⚠️  Groq failed: ${groqErr.message}`);
      }
    }
    
    console.error(`   ❌ All transcription APIs failed`);
    console.error(`   💡 Set OPENAI_API_KEY, AIPIPE_TOKEN, or GROQ_API_KEY in .env`);
    
    return null;
    
  } finally {
    // Cleanup temp files
    try { await unlink(inputPath); } catch (e) {}
    try { await unlink(wavPath); } catch (e) {}
  }
}

/**
 * Extract instructions from transcribed audio
 */
export function parseAudioInstructions(transcript) {
  if (!transcript) return null;
  
  console.log(`\n📋 Parsing audio instructions...`);
  
  const instructions = {
    rawText: transcript,
    operation: null,
    filter: null,
    target: null
  };
  
  // Detect operations
  if (/sum|add|total|aggregate/i.test(transcript)) {
    instructions.operation = 'sum';
  } else if (/count|number of/i.test(transcript)) {
    instructions.operation = 'count';
  } else if (/average|mean/i.test(transcript)) {
    instructions.operation = 'average';
  } else if (/maximum|max|highest/i.test(transcript)) {
    instructions.operation = 'max';
  } else if (/minimum|min|lowest/i.test(transcript)) {
    instructions.operation = 'min';
  }
  
  // Detect filters
  if (/greater than or equal|>=|at least/i.test(transcript)) {
    const match = transcript.match(/(?:greater than or equal to?|>=|at least)\s*(\d+)/i);
    if (match) {
      instructions.filter = { operator: '>=', value: parseInt(match[1]) };
    }
  } else if (/less than or equal|<=|at most/i.test(transcript)) {
    const match = transcript.match(/(?:less than or equal to?|<=|at most)\s*(\d+)/i);
    if (match) {
      instructions.filter = { operator: '<=', value: parseInt(match[1]) };
    }
  } else if (/greater than|>/i.test(transcript)) {
    const match = transcript.match(/(?:greater than|>)\s*(\d+)/i);
    if (match) {
      instructions.filter = { operator: '>', value: parseInt(match[1]) };
    }
  } else if (/less than|below|</i.test(transcript)) {
    const match = transcript.match(/(?:less than|below|<)\s*(\d+)/i);
    if (match) {
      instructions.filter = { operator: '<', value: parseInt(match[1]) };
    }
  }
  
  // Detect target column
  if (/first column/i.test(transcript)) {
    instructions.target = 'first_column';
  } else if (/all columns?|every column/i.test(transcript)) {
    instructions.target = 'all_columns';
  }
  
  console.log(`   Operation: ${instructions.operation || 'not specified'}`);
  console.log(`   Filter: ${instructions.filter ? `${instructions.filter.operator} ${instructions.filter.value}` : 'none'}`);
  console.log(`   Target: ${instructions.target || 'not specified'}`);
  
  return instructions;
}