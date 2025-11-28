// inside solver.js, add at top:
import { handleCsvAudioAndSum } from './audio-helper.js';

// ... where you detect a CSV file (example snippet) ...
if (lower.endsWith('.csv') || lower.includes('text/csv')) {
  try {
    // attempt audio-specific processing & transcription + numeric extraction
    const audioResult = await handleCsvAudioAndSum(buf, fileUrl, page /* optional Playwright page instance */);
    if (audioResult && typeof audioResult.sum === 'number') {
      answer = audioResult.sum;
      console.log('Computed sum from transcribed audio in CSV:', answer);
    } else {
      // fallback to numeric CSV summing
      answer = await sumCsvColumnEnhanced(buf);
    }
  } catch (e) {
    console.warn('Audio processing in CSV failed, falling back to standard CSV sum:', e?.message || e);
    answer = await sumCsvColumnEnhanced(buf).catch(() => 0);
  }
}