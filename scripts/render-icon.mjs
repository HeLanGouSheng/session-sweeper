// Renders media/icon.svg to media/icon.png (the Marketplace only accepts PNG icons).
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync(new URL('../media/icon.svg', import.meta.url));
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
writeFileSync(new URL('../media/icon.png', import.meta.url), png);
console.log(`media/icon.png written (${png.length} bytes)`);
