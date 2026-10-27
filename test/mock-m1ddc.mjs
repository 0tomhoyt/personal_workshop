#!/usr/bin/env node
// m1ddc 的确定性 mock（冒烟测试用）：按 argv 应答，绝不触碰真实 I2C。
//   get input → 从 MOCK_M1DDC_STATE 指向的 JSON 按 uuid= 参数取值（缺省 15 = USB-C/Mac）
//   set input → 写回 state 文件，使 switch → get 往返可断言
// 所有调用参数追加记录到 MOCK_M1DDC_LOG（供断言寻址方式 / 写入值）。
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.MOCK_M1DDC_LOG) fs.appendFileSync(process.env.MOCK_M1DDC_LOG, args.join(' ') + '\n');

const stateFile = process.env.MOCK_M1DDC_STATE;
const readState = () => (stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {});
const uuid = args.find((a) => a.startsWith('uuid=')) || '(no-uuid)';

if (args.includes('get') && args.includes('input')) {
  process.stdout.write(String(readState()[uuid] ?? 15) + '\n');
} else if (args.includes('set') && args.includes('input')) {
  const val = Number(args[args.indexOf('input') + 1]);
  const s = readState();
  s[uuid] = val;
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(s));
}
