const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'csv-import-mapping.json');
const content = fs.readFileSync(filePath, 'utf8');

const keyMatches = [...content.matchAll(/^\s*"((?:\\.|[^"\\])*)"\s*:/gm)];
const seen = new Set();
const duplicates = [];

for (const [, key] of keyMatches) {
  if (seen.has(key)) {
    duplicates.push(key);
  }
  seen.add(key);
}

if (duplicates.length > 0) {
  console.error(`Duplicate keys in csv-import-mapping.json: ${[...new Set(duplicates)].join(', ')}`);
  process.exit(1);
}

try {
  JSON.parse(content);
} catch (error) {
  console.error(`Invalid JSON in csv-import-mapping.json: ${error.message}`);
  process.exit(1);
}

console.log('csv-import-mapping.json is valid JSON');
