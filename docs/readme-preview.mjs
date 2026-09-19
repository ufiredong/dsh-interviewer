/**
 * readme-preview.mjs —— 预览 DSH 市场卡片上会显示成什么样
 *
 *   node docs/readme-preview.mjs
 *
 * 市场抓 README **前约 1200 字符**做卡片简介（数据里的 `readmeSummary` 字段），
 * 并且会**把 markdown 压平成一行**。所以「在 GitHub 上渲染得好看」和
 * 「压平后还读得通」是两件事 —— 而后者才是别人在 dsh.market 上第一眼看到的。
 *
 * 这就是 README 开头刻意写成连续散文、不用列表和引用块的原因（详见 dev-notes.md）。
 * 改完开头跑一下这个，确认压平后仍然可读。
 *
 * 上限 1200 的校准依据：市场数据里 dsh-deepresearch 的 readmeSummary 实际长度是
 * 1174 字符，ruvnet/ruflo 是 1201。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LIMIT = 1200;
const HERE = dirname(fileURLToPath(import.meta.url));

const md = readFileSync(join(HERE, '..', 'README.md'), 'utf8');
const flat = md.replace(/\s+/g, ' ').trim();
const cut = flat.slice(0, LIMIT);

console.log('README 压平后共 ' + flat.length + ' 字符，市场只展示前约 ' + LIMIT
  + ' 字符（' + (100 - Math.round((LIMIT / flat.length) * 100)) + '% 看不到）\n');
console.log('════════ 市场卡片上的效果 ════════\n');
console.log(cut);
console.log('\n══════════════════════════════════\n');

console.log('各节落在压平文本的位置（超过 ' + LIMIT + ' 的看不到）：');
for (const m of md.matchAll(/^## (.+)$/gm)) {
  const pos = flat.indexOf('## ' + m[1]);
  if (pos >= 0) {
    console.log('  ' + String(pos).padStart(6) + '  '
      + (pos < LIMIT ? '✓ 看得到' : '✗ 被截断') + '  ' + m[1]);
  }
}

console.log('\n自检：第一个二级标题之前的内容应该是连续散文（那才是市场卡片最显眼的位置）。');
// ⚠ 判据是"第一个 ## 之前"，不是固定的字符数。
// 第一版写死 500 字符，结果把「它能做什么」的列表也算了进去，误报。
// 开头散文有多长是会变的，锚在标题上才稳。
const firstHeading = flat.indexOf('## ');
const head = flat.slice(0, firstHeading >= 0 ? firstHeading : flat.length);
const bad = [];
if (/(^|\s)- \*\*/.test(head)) bad.push('列表项');
if (/(^|\s)> /.test(head)) bad.push('引用块');
if (/\| --- \|/.test(head)) bad.push('表格');
if (/(^|\s)\d+\. /.test(head)) bad.push('有序列表');
if (bad.length > 0) {
  console.error('✗ 开头散文里出现了：' + bad.join(' / ') + ' —— 压平后会变噪声');
  console.error('  （开头共 ' + head.length + ' 字符）');
  process.exit(1);
}
console.log('✓ 开头 ' + head.length + ' 字符是连续散文');
