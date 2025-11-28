// data-processor.js - Universal data processing utilities
import csvParser from 'csv-parser';
import { Readable } from 'stream';

/**
 * Parse CSV and apply operations (filter, sum, aggregate, etc.)
 * FIXED: Handles headerless CSVs correctly by treating first row as data
 */
export async function processCSV(csvContent, operations = {}) {
  // Check if CSV is headerless (first row contains only numbers)
  const lines = csvContent.split('\n').filter(l => l.trim());
  const firstLine = lines[0] || '';
  const firstValues = firstLine.split(',').map(v => v.trim());
  
  // If >80% of first row values are numbers, it's headerless
  const numericCount = firstValues.filter(v => !isNaN(parseFloat(v)) && isFinite(parseFloat(v))).length;
  const isHeaderless = (numericCount / firstValues.length) > 0.8;
  
  console.log(`   Is headerless: ${isHeaderless} (${numericCount}/${firstValues.length} numeric)`);
  
  let rows = [];
  
  if (isHeaderless) {
    // Parse as headerless - treat ALL rows as data
    console.log(`   Parsing as headerless CSV (ALL rows are data)`);
    
    for (const line of lines) {
      const values = line.split(',').map(v => v.trim());
      const row = {};
      values.forEach((val, idx) => {
        row[`col${idx}`] = val;
      });
      rows.push(row);
    }
  } else {
    // Parse with csv-parser (has headers)
    await new Promise((resolve, reject) => {
      Readable.from(Buffer.from(csvContent, 'utf8'))
        .pipe(csvParser())
        .on('data', (row) => rows.push(row))
        .on('end', resolve)
        .on('error', reject);
    });
  }

  console.log(`📊 CSV parsed: ${rows.length} rows`);
  if (rows.length > 0) {
    console.log(`   Columns: ${Object.keys(rows[0]).join(', ')}`);
  }

  // Extract ALL numeric values from specified columns or all columns
  const allNumbers = [];
  const targetColumn = operations.targetColumn || null;
  
  for (const row of rows) {
    const keysToCheck = targetColumn 
      ? [targetColumn] 
      : Object.keys(row);
    
    for (const key of keysToCheck) {
      if (row[key] === undefined) continue;
      const val = parseFloat(row[key]);
      if (!isNaN(val) && isFinite(val)) {
        allNumbers.push(val);
      }
    }
  }

  console.log(`   Total numbers extracted: ${allNumbers.length}`);
  console.log(`   First 10 numbers: ${allNumbers.slice(0, 10).join(', ')}`);

  // Apply filter if specified
  let filtered = allNumbers;
  if (operations.filter) {
    const { operator, value } = operations.filter;
    console.log(`   Applying filter: ${operator} ${value}`);
    
    if (operator === '<') {
      filtered = allNumbers.filter(n => n < value);
    } else if (operator === '>') {
      filtered = allNumbers.filter(n => n > value);
    } else if (operator === '<=') {
      filtered = allNumbers.filter(n => n <= value);
    } else if (operator === '>=') {
      filtered = allNumbers.filter(n => n >= value);
    } else if (operator === '==') {
      filtered = allNumbers.filter(n => n == value);
    }
    
    console.log(`   After filter: ${filtered.length} numbers remain`);
    console.log(`   First 10 filtered: ${filtered.slice(0, 10).join(', ')}`);
  }

  const sum = filtered.reduce((a, b) => a + b, 0);

  const result = {
    rows,
    rowCount: rows.length,
    columns: Object.keys(rows[0] || {}),
    allNumbers,
    filtered,
    summary: {
      totalNumbers: allNumbers.length,
      filteredNumbers: filtered.length,
      sum: sum,
      mean: filtered.length > 0 ? sum / filtered.length : 0,
      min: filtered.length > 0 ? Math.min(...filtered) : 0,
      max: filtered.length > 0 ? Math.max(...filtered) : 0,
      firstFew: filtered.slice(0, 5)
    }
  };

  console.log(`   ✅ SUM = ${sum}`);

  return result;
}

/**
 * Smart CSV analyzer - detects numeric columns and operations needed
 */
export function analyzeCSV(csvContent) {
  const lines = csvContent.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  const cols = firstLine.split(',');
  
  // Check if headerless (all values in first row are numeric)
  const numericCount = cols.filter(c => !isNaN(parseFloat(c.trim()))).length;
  const isHeaderless = numericCount / cols.length > 0.6;

  return {
    isHeaderless,
    columnCount: cols.length,
    rowCount: lines.length,
    sample: lines.slice(0, 3).join('\n')
  };
}

/**
 * Extract text content from various formats
 */
export function extractText(content, fileType) {
  if (fileType === 'json') {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }
  return content;
}

/**
 * Find patterns in text (emails, URLs, numbers, codes)
 */
export function extractPatterns(text) {
  return {
    emails: text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [],
    urls: text.match(/https?:\/\/[^\s]+/g) || [],
    numbers: text.match(/-?\d+(\.\d+)?/g)?.map(Number) || [],
    codes: text.match(/\b[A-Z0-9]{4,}\b/g) || [],
    secretCodes: text.match(/(?:secret|code|answer|key)\s*(?:is|:|=)\s*([A-Za-z0-9\-_]+)/gi) || []
  };
}

/**
 * Parse and sum numbers with conditions
 */
export function sumNumbersWithCondition(numbers, condition) {
  if (!condition) {
    return numbers.reduce((a, b) => a + b, 0);
  }

  const match = condition.match(/([<>]=?|==|!=)\s*(\d+)/);
  if (!match) {
    return numbers.reduce((a, b) => a + b, 0);
  }

  const [, operator, value] = match;
  const threshold = parseFloat(value);
  
  let filtered;
  switch (operator) {
    case '<': filtered = numbers.filter(n => n < threshold); break;
    case '<=': filtered = numbers.filter(n => n <= threshold); break;
    case '>': filtered = numbers.filter(n => n > threshold); break;
    case '>=': filtered = numbers.filter(n => n >= threshold); break;
    case '==': filtered = numbers.filter(n => n == threshold); break;
    case '!=': filtered = numbers.filter(n => n != threshold); break;
    default: filtered = numbers;
  }

  console.log(`   Applied condition: ${operator} ${threshold}`);
  console.log(`   Filtered: ${numbers.length} → ${filtered.length} numbers`);

  return filtered.reduce((a, b) => a + b, 0);
}