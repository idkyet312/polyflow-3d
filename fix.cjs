const fs = require('fs');
let lines = fs.readFileSync('main.js', 'utf8').split('\n');
lines[6865] = "        item.style.padding = `4px 4px 4px ${4 + depth * 12}px`;";
fs.writeFileSync('main.js', lines.join('\n'), 'utf8');
