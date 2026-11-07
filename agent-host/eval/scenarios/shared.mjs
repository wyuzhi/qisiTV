// 评测场景共用的小工具：只放无业务状态的纯函数，避免场景文件之间互相 import 成环。

export function clone(val) {
  return val === undefined ? undefined : JSON.parse(JSON.stringify(val));
}

// 竖屏 9:16 的精确判定：比例写法必须正好是 9:16（忽略空白）；
// 像素写法按宽高计算比例，与 9/16 的相对偏差不超过 1%。
export function isPortrait916(sizeVal) {
  const compact = String(sizeVal || '').trim().replace(/\s+/g, '').toLowerCase();
  if (!compact) return false;
  if (compact === '9:16') return true;
  const match = /^(\d+)x(\d+)$/.exec(compact);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return false;
  return Math.abs(width / height - 9 / 16) / (9 / 16) <= 0.01;
}
