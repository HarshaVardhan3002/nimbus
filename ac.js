const fs=require('fs');
const s=fs.readFileSync('dist/win-unpacked/resources/app.asar').toString('latin1');
const has=(x)=>s.indexOf(x)>=0;
console.log('  showTab (settings tabs)   : ' + has('function showTab'));
console.log('  renderHistory             : ' + has('async function renderHistory'));
console.log('  renderSession             : ' + has('function renderSession'));
console.log('  no wipe on llm:start      : ' + !has("showSettings(false);\n    clearMessages();"));
console.log('  searchable providers      : ' + has('provider-search'));
console.log('  single chat toggle        : ' + !has('m-chat'));
