const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'dist-wgt');

const filesToCopy = [
  'index.html',
  'config.xml',
  'icon.png',
  path.join('vendor', 'hls.min.js'),
  path.join('vendor', 'mpegts.js')
];

for (const rel of filesToCopy) {
  const src = path.join(rootDir, rel);
  if (!fs.existsSync(src)) {
    console.error(`Arquivo obrigatório ausente: ${rel}`);
    process.exit(1);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'vendor'), { recursive: true });

for (const rel of filesToCopy) {
  const src = path.join(rootDir, rel);
  const dst = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

console.log('Pasta dist-wgt preparada com sucesso para empacotamento WGT:');
for (const rel of filesToCopy) {
  const sizeKb = (fs.statSync(path.join(outDir, rel)).size / 1024).toFixed(1);
  console.log(`  - ${rel} (${sizeKb} KB)`);
}
console.log('\nPróximos passos no seu computador com Tizen Studio:');
console.log('  1. Gerar e assinar o pacote WGT:');
console.log('     tizen package -t wgt -s SEU_PERFIL_CERT -- dist-wgt');
console.log('  2. Conectar na TV (Developer Mode ativo) e instalar:');
console.log('     sdb connect IP_DA_TV:26101');
console.log('     tizen install -n "Lume Player.wgt" -t ID_DA_TV');
