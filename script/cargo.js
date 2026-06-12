const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const cargoBin = process.platform === 'win32'
  ? path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe')
  : path.join(os.homedir(), '.cargo', 'bin', 'cargo');

const args = process.argv.slice(2);
const child = spawn(cargoBin, args, { stdio: 'inherit' });

child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
