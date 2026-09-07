/**
 * 日志取 key 的自检。跑法：node scripts/test-band-key-extract.mjs
 * 最要命的一条是第 2 项：deviceKey 是 did + 32 位密钥，截错方向会得到一个
 * 长度合法、看起来像密钥、但完全错误的字符串，且不会报错。
 */
import assert from 'node:assert/strict';
import { extractKeys } from '../src/main/services/band-key-parse.ts';

const KEY = 'a3f7c2e19b4d6058a1c3e7f2b9d40856'; // 32 位，示例用
const DID = '5029183764'; // 10 位十进制

// 1. 小米健康研究的日志：只有 deviceKey，值是 did + key
const r1 = extractKeys(`INFO device bind ok deviceKey=${DID}${KEY} model=o66`);
assert.equal(r1.deviceKey, KEY, 'deviceKey 应去掉 did 只留末尾 32 位');
assert.equal(r1.deviceKeyRaw, DID + KEY);
assert.equal(r1.encryptKey, null);

// 2. 截错方向的反向断言：不能等于整串的前 32 位
assert.notEqual(r1.deviceKey, (DID + KEY).slice(0, 32), '不能从开头截 32 位');

// 3. Mi Fitness 导出的日志：只有 encryptKey，本来就是 32 位
const r2 = extractKeys(`detail encryptKey: ${KEY} beaconKey: ffffffffffffffffffffffffffffffff`);
assert.equal(r2.encryptKey, KEY);
assert.equal(r2.deviceKey, null);
assert.notEqual(r2.encryptKey, 'ffffffffffffffffffffffffffffffff', 'beaconKey 与认证无关，不能抓成它');

// 4. 每次重新绑定都会换 key —— 必须取最后一次出现的那组
const older = '11111111111111111111111111111111';
const r3 = extractKeys(`encryptKey=${older}\n...\nencryptKey=${KEY}\n`);
assert.equal(r3.encryptKey, KEY, '应取最后一次出现的 key');

// 5. 两个关键词同时存在且一致时要能判定一致
const r4 = extractKeys(`deviceKey=${DID}${KEY}\nencryptKey=${KEY}`);
assert.equal(r4.deviceKey, r4.encryptKey, '同一份日志里两者应当一致');

// 6. did 长度不固定：8 位和 11 位都要正确取尾
for (const did of ['50291837', '50291837641']) {
  assert.equal(extractKeys(`deviceKey=${did}${KEY}`).deviceKey, KEY, `did 长度 ${did.length} 时应仍取末尾 32 位`);
}

// 7. 没有 key 的日志不能瞎猜
const r5 = extractKeys('INFO nothing interesting here 1234');
assert.equal(r5.deviceKey, null);
assert.equal(r5.encryptKey, null);

console.log('✅ 日志取 key 自检通过（7 项）');
