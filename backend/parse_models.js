const fs = require('fs');
const path = require('path');

const modelsDir = path.join(__dirname, 'src', 'models');
const files = fs.readdirSync(modelsDir).filter(f => f.endsWith('.ts') && f !== 'index.ts');

const camelToSnake = (str) => str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

const replacements = {};

files.forEach(file => {
  const content = fs.readFileSync(path.join(modelsDir, file), 'utf8');
  // Match declare camelCase: Type;
  const regex = /declare\s+([a-zA-Z]+[A-Z][a-zA-Z0-9]*)\??:/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const propName = match[1];
    const snakeCase = camelToSnake(propName);
    replacements[propName] = snakeCase;
  }
});

console.log(JSON.stringify(replacements, null, 2));
