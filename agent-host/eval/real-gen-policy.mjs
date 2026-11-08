// 回合推进策略：失败/超时后不再确认，也不进入下一轮；任务失败同样停止后续轮次。
export function canConfirmRound(round) {
  return Boolean(round) && round.status === 'done' && !round.error;
}

export function roundStopReason(round) {
  if (!canConfirmRound(round)) return `turn_${round?.status || 'unknown'}`;
  const failed = (round.tasks || []).find((task) => task.status === 'failed' || task.status === 'cancelled');
  if (failed) return `task_${failed.status}`;
  return '';
}

export function taskKind(task) {
  if (String(task.type || '').includes('timeline')) return 'render';
  if (task.type === 'canvas_image') return 'image';
  if (task.type === 'canvas_video') return 'video';
  if (String(task.type || '').startsWith('video')) return 'video';
  return 'media';
}

// 场景要求的完整产物：2 张首帧、2 段视频、1 个成片，任务成功且文件已下载。缺任何一项都判失败，
// 不能因为三轮都正常回复就宣告成功。
export const REQUIRED_OUTPUTS = { image: 2, video: 2, render: 1 };
export function completenessGaps(tasks, artifacts, required = REQUIRED_OUTPUTS) {
  const gaps = [];
  for (const [kind, count] of Object.entries(required)) {
    const succeeded = tasks.filter((task) => taskKind(task) === kind && task.status === 'succeeded').length;
    const saved = artifacts.filter((artifact) => artifact.kind === kind && artifact.bytes > 0).length;
    if (succeeded < count) gaps.push(`${kind} 成功任务 ${succeeded}/${count}`);
    if (saved < count) gaps.push(`${kind} 已下载产物 ${saved}/${count}`);
  }
  return gaps;
}
