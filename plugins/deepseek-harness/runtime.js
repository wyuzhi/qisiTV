import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('.', import.meta.url))

const mcpOperationName = id => `mcp__beeftv__${id.replace(/[^A-Za-z0-9_-]/g, '_')}`
const mcpToolBase = name => typeof name === 'string' ? name.replace(/_[a-f0-9]{12}$/, '') : ''
const mediaReviewTool = mcpOperationName('media.review')
const submitToolPattern = /^mcp__beeftv__canvas_generation_submit(?:_[a-f0-9]{12})?$/
const regenerateToolPattern = /^mcp__beeftv__canvas_generation_regenerate(?:_[a-f0-9]{12})?$/
// submit 与 regenerate 都会创建付费任务；两者提交成功后都要等结果并唤醒。
const generationSubmissionPattern = /^mcp__beeftv__canvas_generation_(?:submit|regenerate)(?:_[a-f0-9]{12})?$/

// 连接时从操作目录收集「执行即创建付费生成任务」的工具名。
// 已知的 submit / regenerate 另有按名兜底，目录缺失或漏标时也不会漏审批。
// 目录读不到时返回 null：调用方据此区分「目录为空」和「根本没有目录」。
export function generationToolSet(operations) {
  if (!Array.isArray(operations)) return null
  const names = new Set()
  for (const operation of operations) {
    if (operation?.submitsGeneration === true && typeof operation?.id === 'string' && operation.id) {
      names.add(mcpOperationName(operation.id))
    }
  }
  return { names }
}

// 拿不到操作目录时仍能确定不产生费用、不修改画布的工具：CLI 自己的发现工具和只返回报价的 propose。
const freeWithoutCatalogTool = /^mcp__beeftv__(?:business_list|canvas_generation_propose)(?:_[a-f0-9]{12})?$/

// 目录不可用时无法判断一个工具是否收费，审批卡只能如实说明，不能承诺免费。
export const unknownCatalogReason = '暂时无法确认这次操作是否产生费用或修改画布，请核对后再允许。'

// The catalog describes reads that still cost money (replay: unsafe). A catalog entry for the
// known paid review, or a missing entry, must never silently skip approval.
export function unsafeOperation(name, operations = []) {
  const tool = mcpToolBase(name)
  if (tool === mediaReviewTool) return { id: 'media.review', readOnly: true, replay: 'unsafe' }
  const catalog = Array.isArray(operations) ? operations : []
  const matched = catalog.find(operation => mcpOperationName(String(operation?.id || '')) === tool)
  return matched?.readOnly === true && matched.replay === 'unsafe' ? matched : undefined
}

function secondsLabel(milliseconds) {
  const value = Number(milliseconds)
  if (!Number.isFinite(value) || value < 0) return null
  return String(Math.round(value / 100) / 10)
}

// Names what the review will inspect. The review has no quote, so no amount appears.
export function reviewApprovalReason(args = {}) {
  const start = secondsLabel(args?.startMs)
  const end = secondsLabel(args?.endMs)
  const segment = start === null || end === null || Number(end) <= Number(start) ? '' : `片段：${start}–${end} 秒。`
  const model = typeof args?.model === 'string' ? args.model.trim().slice(0, 80) : ''
  return `审片会调用审片模型，可能收费。${segment}${model ? `模型：${model}。` : ''}`
}

export function requiresGenerationApproval(name, args, businessTools = [], operations, generationTools = generationToolSet(operations)) {
  const tool = mcpToolBase(name)
  if (!tool.startsWith('mcp__beeftv__')) return false
  // 已知付费生成操作按名兜底：目录缺失、切换窗口 current 为空或条目漏标时也不能放行。
  // 旧后端没有 submitsGeneration 字段时，submit 也照旧按工具名审批。
  if (submitToolPattern.test(name) || regenerateToolPattern.test(name)) return true
  if (unsafeOperation(name, operations)) return true
  // 拿不到操作目录（切换或释放窗口）时，未知工具不能当免审批：除了确定不收费的读取，一律先请求审批。
  // 完全权限由 Host 在审批判断之后放行，这里不做例外。
  if (generationTools === null) return !freeWithoutCatalogTool.test(tool)
  // 命中目录里 submitsGeneration 的操作（含带哈希后缀的工具名）一律审批，未来新增的付费操作也覆盖。
  if (generationTools?.names?.has(tool)) return true
  if (!/^mcp__beeftv__business_call(?:_[a-f0-9]{12})?$/.test(name)) return false
  const businessTool = businessTools.find(item => item.id === args?.tool)
  return !(businessTool?.readOnly === true && businessTool?.submitsGeneration === false)
}

const proposeToolName = /^mcp__beeftv__canvas_generation_propose(?:_[a-f0-9]{12})?$/
const generationUnits = { image: ['张', '图片'], video: ['段', '视频'], audio: ['段', '音频'] }

// Keeps BeefTV's own quote for each proposal, so the approval card can say what the user pays for.
export function rememberQuote(quotes, name, result) {
  if (result?.isError || !proposeToolName.test(name)) return
  const text = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text : undefined
  let quote
  try {
    quote = JSON.parse(text)?.result
  } catch {
    return
  }
  if (typeof quote?.proposalId !== 'string' || !quote.proposalId) return
  quotes.delete(quote.proposalId)
  quotes.set(quote.proposalId, quote)
  // Bounded so a long session does not keep every quote it ever saw.
  while (quotes.size > 50) quotes.delete(quotes.keys().next().value)
}

// 报价里只认这次提交的节点：一张生成单可以只重提其中一部分（例如只重试失败节点）。
function quotedSubmission(args, quotes) {
  const quote = quotes.get(args?.proposalId)
  const submitted = Array.isArray(args?.nodeIds) ? args.nodeIds : []
  const quoted = Array.isArray(quote?.targets) ? quote.targets : []
  const targets = quoted.filter(target => submitted.includes(target?.nodeId))
  if (!quote || !submitted.length || targets.length !== new Set(submitted).size) return null
  return { quote, targets }
}

function generationDetail(targets) {
  const kinds = [...new Set(targets.map(target => target.kind))]
  const [unit, label] = kinds.length === 1 ? generationUnits[kinds[0]] || ['项', '生成'] : ['项', '生成']
  const amount = targets.reduce((sum, target) => sum + (target.kind === 'image' ? Number(target.parameters?.count) || 1 : 1), 0)
  const models = [...new Set(targets.map(target => target.model).filter(model => typeof model === 'string' && model))]
  return `生成 ${amount} ${unit}${label}${models.length ? `（${models.join('、')}）` : ''}`
}

// 有整单报价时用 BeefTV 的金额文案；只有部分节点有报价时说明其余按渠道计费。
function generationCost(quote, targets) {
  const quoted = Array.isArray(quote?.targets) ? quote.targets : []
  const priced = targets.filter(target => Number.isFinite(target.estimate?.amount))
  if (targets.length === quoted.length && typeof quote.estimate?.text === 'string' && quote.estimate.text) {
    return quote.estimate.text.replace(/[。.]+$/, '')
  }
  if (priced.length === targets.length) {
    return `预计费用：¥${Number(priced.reduce((sum, target) => sum + target.estimate.amount, 0).toFixed(4))}`
  }
  return priced.length ? '部分费用按所选渠道实际计费' : '费用按所选渠道实际计费'
}

// 原地重做替换节点上的当前显示，旧结果仍留在素材库；没有报价时不写金额，也不说已经扣费。
function regenerateApprovalReason(args, quotes) {
  const matched = quotedSubmission(args, quotes)
  const detail = matched ? `${generationDetail(matched.targets)}。` : ''
  const cost = matched ? generationCost(matched.quote, matched.targets) : '费用按所选渠道实际计费'
  return `BeefTV 将在原节点重新生成并计费，原有结果（如有）会留在素材库。${detail}${cost}。`
}

// Text for the DSH approval card. It names only the nodes this submission sends: a proposal can be
// submitted again for a subset, such as retrying failed nodes. Prices are BeefTV's per-node quotes.
export function approvalReason(name, args, businessTools = [], quotes = new Map(), operations) {
  const unsafe = unsafeOperation(name, operations)
  if (unsafe) {
    return unsafe.id === 'media.review'
      ? reviewApprovalReason(args)
      : `BeefTV 将执行只读操作 ${unsafe.id}，可能调用外部模型并产生费用。请核对本次操作。`
  }
  if (regenerateToolPattern.test(name)) return regenerateApprovalReason(args, quotes)
  if (!submitToolPattern.test(name)) {
    // 目录不可用时没有依据判断费用和影响，不能沿用「未识别」文案暗示可能免费。
    if (generationToolSet(operations) === null) return unknownCatalogReason
    const business = businessTools.find(tool => tool.id === args?.tool)
    return business
      ? `BeefTV 请求执行 ${business.method} ${business.path}${business.submitsGeneration ? '，将提交可能计费的生成任务' : '，将修改工作区'}。请核对本次操作。`
      : 'BeefTV 将提交生成或未识别的业务操作，可能修改工作区或产生费用，请核对本次操作。'
  }
  const matched = quotedSubmission(args, quotes)
  if (!matched) {
    return 'BeefTV 将提交付费生成，但这次提交和已有报价对不上，无法显示费用。可以先拒绝，让 Agent 重新报价后再提交。'
  }
  return `BeefTV 将${generationDetail(matched.targets)}。${generationCost(matched.quote, matched.targets)}。`
}

// ---- 生成完接着做：设置、任务判定与唤醒文案 ----

export const defaultPluginSettings = Object.freeze({ autoContinue: true, stepLimit: 40 })
export const minimumStepLimit = 5
export const maximumStepLimit = 200

// 设置文件来自本机磁盘，读坏或旧字段都以默认值继续，避免插件整体不可用。
export function normalizeSettings(value) {
  const autoContinue = typeof value?.autoContinue === 'boolean' ? value.autoContinue : defaultPluginSettings.autoContinue
  const stepLimit = Number.isInteger(value?.stepLimit) && value.stepLimit >= minimumStepLimit && value.stepLimit <= maximumStepLimit
    ? value.stepLimit
    : defaultPluginSettings.stepLimit
  return { autoContinue, stepLimit }
}

// 设置写入入口比读取严格：界面只能提交合法值，拼错或越界直接拒绝。
export function validatedSettingsPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('没能保存这项设置，请重试。')
  const patch = {}
  if ('autoContinue' in value) {
    if (typeof value.autoContinue !== 'boolean') throw new Error('没能保存这项设置，请重试。')
    patch.autoContinue = value.autoContinue
  }
  if ('stepLimit' in value) {
    if (!Number.isInteger(value.stepLimit) || value.stepLimit < minimumStepLimit || value.stepLimit > maximumStepLimit) {
      throw new Error(`每轮工具调用上限请填 ${minimumStepLimit} 到 ${maximumStepLimit} 之间的整数。`)
    }
    patch.stepLimit = value.stepLimit
  }
  if (!Object.keys(patch).length) throw new Error('没有需要保存的改动。')
  return patch
}

function resultPayload(result) {
  const text = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text : undefined
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed?.result && typeof parsed.result === 'object' ? parsed.result : parsed
  } catch {
    return null
  }
}

// 成功提交的返回里可能有 taskIds（整批）或 taskId（单个）。重复提交复用同一任务时也只认一次。
// 原地重做和普通提交一样会创建任务；「每次问我」返回 pending_approval 时还没生成、没扣费，
// 不能当成提交成功去等结果或唤醒。
export function submittedTaskIds(name, result) {
  if (!generationSubmissionPattern.test(name) || result?.isError) return []
  const payload = resultPayload(result)
  if (payload?.status === 'pending_approval') return []
  const values = Array.isArray(payload?.taskIds) ? payload.taskIds : payload?.taskId ? [payload.taskId] : []
  return [...new Set(values.filter(id => typeof id === 'string' && id))]
}

function taskPhase(task) {
  return typeof task?.outcome?.phase === 'string' ? task.outcome.phase : ''
}

function resultStateReady(task) {
  if (typeof task?.resultState !== 'string' || !task.resultState) return true
  const normalized = task.resultState.toLowerCase()
  return normalized === 'ready' || normalized === 'succeeded'
}

function taskSaved(task) {
  if (task?.status !== 'succeeded') return false
  const phase = taskPhase(task)
  if (phase && phase !== 'ready') return false
  if (!resultStateReady(task)) return false
  return Boolean(task.outputs?.length && task.outputs.every(output => output?.resourceId && !output?.materializationErrorCode))
}

// 与内置 await-business-tasks 一致：任务本身成功但产物没能保存，是「未完成入库」，
// 不是生成失败；这类结果只能重新保存，不能重新生成。
function taskIncomplete(task) {
  if (task?.status !== 'succeeded') return false
  // 结果还在下载/重试入库时不能提前说「没保存成功」，否则模型会重复保存或重新生成。
  if (taskDeliveryPending(task)) return false
  const phase = taskPhase(task)
  if (phase === 'failed') return true
  if (typeof task?.resultState === 'string' && task.resultState.toLowerCase() === 'failed_permanent') return true
  // failed_retryable 表示后端还在重试入库，不能提前当成「保存失败」。
  if (typeof task?.resultState === 'string' && task.resultState.toLowerCase() === 'failed_retryable') return false
  if (phase === 'fetching' || phase === 'retrievable') return false
  return Boolean(task?.outputs?.length && task.outputs.every(output => output?.resourceId || output?.materializationErrorCode) &&
    task.outputs.some(output => output?.materializationErrorCode))
}

function taskDeliveryPending(task) {
  const outputs = task?.delivery?.outputs
  return Array.isArray(outputs) && outputs.some(output => ['downloading', 'retrying', 'waiting'].includes(output?.state))
}

function taskFailed(task) {
  if (task?.status === 'cancelled') return true
  const phase = taskPhase(task)
  if (phase === 'retrievable' || phase === 'fetching' || phase === 'running') return false
  // failed_retryable 只对已成功的生成表示「结果还在下载/重试入库」；失败任务的可重试标记仍是终态失败。
  if (task?.status === 'succeeded' && typeof task?.resultState === 'string' && task.resultState.toLowerCase() === 'failed_retryable') return false
  // /ops/task.get 不一定带 outcome.phase；投递还在下载或重试时不能当成终态失败。
  if (taskDeliveryPending(task)) return false
  return task?.status === 'failed'
}

// 后端 reason 与入库错误码是内部值，拼进对话前先换成用户能看懂的短句；认不出的内部码不展示。
const readableReasons = {
  cancelled: '已取消', canceled: '已取消',
  materialization_failed: '结果没有保存成功', persist_failed: '结果没有保存成功',
  result_unrecoverable: '结果无法取回', charged_result_unrecoverable: '已扣费，但结果无法取回',
  no_result: '没有拿到结果', input_rejected: '内容未通过审核',
  settlement_pending: '正在核对费用',
  download_failed: '结果下载失败', delivery_paused: '结果保存已暂停',
  resource_missing: '结果资源不存在', resource_not_ready: '结果还没准备好',
  delivery_unreadable: '读不到结果',
  resource_foreign: '结果不属于这个工作区', asset_foreign: '结果不属于这个工作区',
  unsupported_result_shape: '结果格式不支持',
}

function readableReason(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  const mapped = readableReasons[text.toLowerCase()]
  if (mapped) return mapped
  // 全小写加下划线的值按内部码处理，不把 task_failed 这类词带给用户。
  if (/^[a-z][a-z0-9_]*$/.test(text)) return ''
  return text.replace(/\s+/g, ' ').slice(0, 120)
}

function failureReason(task) {
  const error = task?.error
  const candidates = [
    typeof error === 'string' ? error : undefined,
    typeof error?.message === 'string' ? error.message : undefined,
    typeof error?.msg === 'string' ? error.msg : undefined,
    task?.reason,
    task?.note,
  ]
  for (const value of candidates) {
    const text = readableReason(value)
    if (text) return text
  }
  const materialized = Array.isArray(task?.outputs) && task.outputs.find(output => output?.materializationErrorCode)
  const materializedText = materialized ? readableReason(String(materialized.materializationErrorCode)) : ''
  if (materializedText) return materializedText
  if (task?.status === 'cancelled') return '已取消'
  return ''
}

// 判定照搬内置 await-business-tasks：成功、产物已保存、可绑定才算完成。
export function taskOutcome(task, taskId = task?.taskId) {
  if (taskSaved(task)) return { taskId, state: 'succeeded', reason: '' }
  if (taskFailed(task)) return { taskId, state: 'failed', reason: failureReason(task) }
  if (taskIncomplete(task)) return { taskId, state: 'incomplete', reason: '结果没有保存成功，只能重新保存，不能重新生成' }
  return { taskId, state: 'pending', reason: '' }
}

// task.wait 超时返回 pending；任务详情退回用同一套判定，不把暂时读不到当成失败。
function listedTaskState(value, taskId) {
  const listed = Array.isArray(value?.tasks) ? value.tasks.find(task => task?.taskId === taskId) || (value.tasks.length === 1 ? value.tasks[0] : undefined) : undefined
  // 仍在下载/重试入库的结果不能按 listed.status=succeeded 直接算完成。
  if (listed && taskDeliveryPending(listed)) return { taskId, state: 'pending', reason: '' }
  // 保存/下载中的中间态继续等，不能因为带了 materializationErrorCode 就提前下结论。
  const listedState = typeof listed?.state === 'string' ? listed.state.toLowerCase() : ''
  if (['downloading', 'retrying', 'waiting', 'saving', 'fetching', 'running', 'pending', 'queued'].includes(listedState)) {
    return { taskId, state: 'pending', reason: '' }
  }
  // 真实 task.wait 对「生成成功但产物永久保存失败」返回 state=failed + reason=materialization_failed；
  // 这只能重新保存，不能当成生成失败让模型重新生成。
  const reason = typeof listed?.reason === 'string' ? listed.reason.toLowerCase() : ''
  const resultState = typeof listed?.resultState === 'string' ? listed.resultState.toLowerCase() : ''
  const successful = listed?.status === 'succeeded' || ['succeeded', 'success', 'completed', 'ready'].includes(listedState)
  // 只有已成功的生成还在重试入库时才继续等；失败任务的重试标记仍是终态失败。
  if (successful && resultState === 'failed_retryable') return { taskId, state: 'pending', reason: '' }
  // 失败任务也可能带 FAILED_PERMANENT（表示重试被阻断），不能当成物化失败；只有成功的生成才讨论「结果没保存」。
  const materialization = successful && (reason === 'materialization_failed' || resultState === 'failed_permanent'
    || (Array.isArray(listed?.outputs) && listed.outputs.some(output => output?.materializationErrorCode)))
  if (materialization) {
    const original = failureReason(listed)
    const base = '结果没有保存成功，只能重新保存，不能重新生成'
    return { taskId, state: 'incomplete', reason: original ? `${base}（${original}）` : base }
  }
  const raw = typeof listed?.state === 'string' ? listed.state : typeof listed?.status === 'string' ? listed.status : ''
  const state = raw.toLowerCase()
  if (['succeeded', 'success', 'completed', 'ready'].includes(state)) return { taskId, state: 'succeeded', reason: '' }
  if (['incomplete', 'materialization_failed'].includes(state)) {
    const original = failureReason(listed)
    const base = '结果没有保存成功，只能重新保存，不能重新生成'
    return { taskId, state: 'incomplete', reason: original ? `${base}（${original}）` : base }
  }
  if (['failed', 'error', 'cancelled', 'canceled'].includes(state)) return { taskId, state: 'failed', reason: failureReason(listed) || (state.startsWith('cancel') ? '已取消' : '') }
  // saving/downloading 等还在入库或下载的中间态，以及认不出的新状态，都按未完成处理，不提前下结论。
  if (state) return { taskId, state: 'pending', reason: '' }
  return undefined
}

export function waitOutcome(value, taskId) {
  const status = typeof value?.status === 'string' ? value.status.toLowerCase() : ''
  // 后端可能返回单个状态，也可能返回整批的 tasks/pending/completed/failed 汇总；两种都认。
  const listed = Array.isArray(value?.tasks) ? value.tasks.find(task => task?.taskId === taskId) || (value.tasks.length === 1 ? value.tasks[0] : undefined) : undefined
  if (status === 'succeeded' || status === 'success' || status === 'completed' || status === 'ready') return { taskId, state: 'succeeded', reason: '' }
  if (status === 'incomplete' || status === 'materialization_failed') {
    const original = failureReason(listed || value?.task || value)
    const base = '结果没有保存成功，只能重新保存，不能重新生成'
    return { taskId, state: 'incomplete', reason: original ? `${base}（${original}）` : base }
  }
  if (status === 'failed' || status === 'error') {
    // 顶层说 failed，但按任务看其实是「产物没保存」时，仍按 incomplete 处理，避免模型重新生成。
    const listedOutcome = listedTaskState(value, taskId)
    if (listedOutcome?.state === 'incomplete') return listedOutcome
    return { taskId, state: 'failed', reason: failureReason(listed || value?.task || value) }
  }
  if (status === 'cancelled' || status === 'canceled') return { taskId, state: 'failed', reason: '已取消' }
  if (status === 'pending' || status === 'running' || status === 'queued') return { taskId, state: 'pending', reason: '' }
  const listedOutcome = listedTaskState(value, taskId)
  if (listedOutcome) return listedOutcome
  if (value?.cancelled === true || listed?.cancelled === true) return { taskId, state: 'failed', reason: '已取消' }
  if (Array.isArray(value?.failedTaskIds) && value.failedTaskIds.includes(taskId)) return { taskId, state: 'failed', reason: failureReason(listed) }
  if (Array.isArray(value?.completedTaskIds) && value.completedTaskIds.includes(taskId)) return { taskId, state: 'succeeded', reason: '' }
  if (value?.pending === true || value?.timedOut === true || (typeof value?.pending === 'number' && value.pending > 0)) return { taskId, state: 'pending', reason: '' }
  const failedCount = typeof value?.failed === 'number' ? value.failed : 0
  const completedCount = typeof value?.completed === 'number' ? value.completed : 0
  // 汇总里同时有成功和失败、又没有按任务的 id 时无法判断这一项，继续等下一次更具体的结果。
  if (failedCount > 0 && completedCount > 0) return { taskId, state: 'pending', reason: '' }
  if (value?.failed === true || failedCount > 0) return { taskId, state: 'failed', reason: failureReason(listed) }
  if (value?.completed === true || completedCount > 0) return { taskId, state: 'succeeded', reason: '' }
  if (value && typeof value === 'object' && ('status' in value || 'taskId' in value || 'outcome' in value || 'outputs' in value)) return taskOutcome(value, taskId)
  return { taskId, state: 'pending', reason: '' }
}

export function awaitWakeText(outcomes) {
  const taskIds = [...new Set(outcomes.map(outcome => outcome.taskId))]
  const failed = outcomes.filter(outcome => outcome.state === 'failed')
  const incomplete = outcomes.filter(outcome => outcome.state === 'incomplete')
  const succeeded = outcomes.length - failed.length - incomplete.length
  const parts = []
  if (failed.length) {
    const reason = failed.map(outcome => outcome.reason).find(Boolean)
    parts.push(`${failed.length} 个失败${reason ? `（${reason}）` : ''}`)
  }
  if (incomplete.length) {
    // 结果没入库不是生成失败，固定写明只能重新保存，避免模型重新提交。
    const reason = incomplete.map(outcome => outcome.reason).find(Boolean) || '结果没有保存成功，只能重新保存，不能重新生成'
    parts.push(`${incomplete.length} 个结果未保存（${reason}）`)
  }
  const detail = parts.length ? `，${parts.join('，')}` : ''
  return `生成已结束：${succeeded} 个成功${detail}。任务：${taskIds.join('、')}。请只查询结果、绑定到节点并继续，不要重新提交。`
}

export function stepLimitNotice(limit) {
  return `这一轮已经做了 ${limit} 步，先停一下。要继续请再说一句。`
}

export function awayGenerationNotice(count) {
  return count > 0 ? `有 ${count} 个生成在你离开时完成。` : ''
}

// agent.guide 是可选的只读操作。有它时整段替换插件的说明，只补 DSH 独有的两句。
export const maximumGuideChars = 100_000

export function guidedPrompt(guide, fallback) {
  const text = typeof guide?.text === 'string' ? guide.text.trim() : ''
  // 异常超长的说明会挤掉工具定义和对话空间，宁可用插件内置的那份。
  if (!text || text.length > maximumGuideChars) return fallback
  return `${text}\n在 DeepSeek Harness 中，BeefTV 工具名带 mcp__beeftv__ 前缀。付费生成是否需要用户确认由 DSH 的访问模式决定：弹出审批时等用户确认，完全权限下直接执行，不要另外追问。`
}

export function runtimeRecord(value) {
  for (const key of ['bridgeURL', 'baseURL']) {
    const url = new URL(value?.[key])
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('工作区地址必须为本机回环地址')
  }
  if (typeof value.bridgeToken !== 'string' || !value.bridgeToken) throw new Error('工作区未返回桥接凭据')
  return value
}

export function embeddedDocument(html, basePath, parentOrigin = '*') {
  const config = JSON.stringify({ embedded: true, apiBase: `${basePath}/api`, basePath, parentOrigin }).replaceAll('<', '\\u003c')
  // The asset page's stacking context otherwise puts its narrow sidebar below the dismiss scrim.
  const styles = `<style>
html .app-workspace-shell:has(.assets-library-page) .app-workspace-main-row{z-index:auto}
/* Only top controls avoid the host overlay. The page and canvas remain full width. */
html .canvas-topbar{padding-left:calc(8px + var(--beeftv-host-leading,0px))!important}
html .app-user-workspace .app-workspace-floating-menu{left:calc(12px + var(--beeftv-host-leading,0px))!important}
/* A full sidebar stays in place. Its brand row can sit below the host controls. */
html[data-beeftv-host-chrome] .app-workspace-sidebar-brand-row,
html[data-beeftv-host-chrome] .app-workspace-sidebar-rail-header{margin-top:48px}
</style>`
  const bridge = `<script>(${embeddedChromeBridge.toString()})()</script>`
  return html.replace(/<base\b[^>]*>/gi, '').replace(/<head[^>]*>/i, match => `${match}<base href="${basePath}/"><meta name="referrer" content="no-referrer">${styles}<script>window.__BEEFTV_HARNESS__=${config}</script>${bridge}`)
}

// The parent only transmits bounded layout metrics, never workspace data or credentials.
function embeddedChromeBridge() {
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'beeftv:host-chrome') return
    const leading = event.data.leading
    if (typeof leading !== 'number' || !Number.isFinite(leading) || leading < 0 || leading > 320) return
    document.documentElement.style.setProperty('--beeftv-host-leading', `${leading}px`)
    document.documentElement.toggleAttribute('data-beeftv-host-chrome', leading > 0)
  })
  // 把当前明暗、底色、前景与主按钮配色告诉宿主，由宿主侧统一解析颜色、筛掉无彩度值并校验对比度。
  // 只发送颜色事实，不带工作区数据或凭据。
  let themeTimer
  const postTheme = () => {
    if (!document.body) return
    const root = document.documentElement
    const rootStyle = getComputedStyle(root)
    const dark = root.classList.contains('dark') || rootStyle.colorScheme === 'dark'
    const shell = document.querySelector('.app-workspace-shell') || document.body
    const background = getComputedStyle(shell).backgroundColor
    const foreground = getComputedStyle(document.body).color
    const accent = rootStyle.getPropertyValue('--primary').trim().slice(0, 64)
    const accentForeground = rootStyle.getPropertyValue('--primary-foreground').trim().slice(0, 64)
    window.parent.postMessage({ type: 'beeftv:theme', dark, background, foreground, accent, accentForeground }, '*')
  }
  const scheduleTheme = () => {
    clearTimeout(themeTimer)
    themeTimer = setTimeout(postTheme, 120)
  }
  window.addEventListener('load', scheduleTheme)
  new MutationObserver(scheduleTheme).observe(document.documentElement, { attributes: true })
  scheduleTheme()
}

export function publicContext(value) {
  if (!value || typeof value.route !== 'string' || !value.route.startsWith('/') || value.route.startsWith('//') || value.route.length > 2048) throw new Error('无效的工作区上下文')
  const context = { route: value.route }
  for (const key of ['canvasId', 'canvasTitle']) {
    if (typeof value[key] === 'string') context[key] = value[key].slice(0, 256)
  }
  context.selectedNodeIds = Array.isArray(value.selectedNodeIds) ? value.selectedNodeIds.filter(id => typeof id === 'string').slice(0, 100).map(id => id.slice(0, 256)) : []
  return context
}

// Paths DeepSeek Harness manages itself. The embedded workspace page never reaches them.
const managedWorkspacePaths = ['/api/assistant', '/api/ops/clients', '/api/agent-clients']

// Judges the raw request path. URL parsers resolve encoded separators and dot segments differently
// from the Go bridge, so ambiguous spellings are refused instead of resolved. Returns 0, 400 or 403.
export function embeddedPathRejection(rawPath) {
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /[\\#]|%(?:2f|5c|25)/i.test(rawPath)) return 400
  let path
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return 400
  }
  const segments = path.split('/').slice(1)
  if (segments.some((segment, index) => segment === '.' || segment === '..' || (segment === '' && index < segments.length - 1))) return 400
  // The bridge also serves the workspace under /beeftv/app, so that prefix is removed before matching.
  const effective = (path.replace(/^\/beeftv\/app(?=\/|$)/i, '') || '/').toLowerCase()
  return managedWorkspacePaths.some(managed => effective === managed || effective.startsWith(`${managed}/`)) ? 403 : 0
}

const localApp = {
  bundle: '/Applications/BeefTV.app',
  info: '/Applications/BeefTV.app/Contents/Info.plist',
  executable: '/Applications/BeefTV.app/Contents/MacOS/BeefTV',
  cli: '/Applications/BeefTV.app/Contents/MacOS/cli/beeftv',
}
// 2.2.0 is the first desktop release with the harness bridge. Older builds pass unknown flags to the
// GUI, so starting them with harness flags would open the desktop window instead of attaching.
const minimumLocalAppVersion = '2.2.0'

function supportsHarness(version) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version || '')?.slice(1).map(Number)
  if (!parts) return false
  const minimum = minimumLocalAppVersion.split('.').map(Number)
  const index = parts.findIndex((part, position) => part !== minimum[position])
  return index === -1 || parts[index] > minimum[index]
}

function bundleVersion(plist) {
  return new Promise(resolve => {
    execFile('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plist], { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null)
    })
  })
}

export async function localAppStatus() {
  try {
    await Promise.all([access(localApp.executable, constants.X_OK), access(localApp.cli, constants.X_OK)])
  } catch {
    return { compatible: false, version: null, message: `未找到本机 BeefTV。请安装 ${minimumLocalAppVersion} 或更高版本后重新连接。` }
  }
  const version = await bundleVersion(localApp.info)
  if (supportsHarness(version)) return { compatible: true, version, message: null }
  return {
    compatible: false, version,
    message: version
      ? `本机 BeefTV 版本为 ${version}，需要 ${minimumLocalAppVersion} 或更高版本。请升级后重新连接。`
      : `无法读取本机 BeefTV 的版本。请重新安装 ${minimumLocalAppVersion} 或更高版本后重新连接。`,
  }
}

async function requireLocalApp() {
  const app = await localAppStatus()
  if (!app.compatible) throw new Error(app.message)
}

async function bundledPaths() {
  const contents = join(root, 'runtime', 'Contents')
  const paths = { executable: join(contents, 'MacOS', 'BeefTV'), cli: join(contents, 'MacOS', 'cli', 'beeftv') }
  try {
    await Promise.all(Object.values(paths).map(path => access(path, constants.X_OK)))
  } catch (error) {
    throw new Error('插件缺少内置的 BeefTV 运行时，请重新安装插件', { cause: error })
  }
  return paths
}

export async function startLocalRuntime() {
  await requireLocalApp()
  try {
    await new Promise((resolve, reject) => {
      execFile('/usr/bin/open', ['-a', localApp.bundle], { timeout: 10_000 }, error => {
        if (error) reject(error)
        else resolve()
      })
    })
  } catch (error) {
    throw new Error('无法打开本机 BeefTV，请确认 /Applications/BeefTV.app 已完整安装', { cause: error })
  }
  const deadline = Date.now() + 30_000
  let lastFailure
  while (Date.now() < deadline) {
    try {
      return await launchRuntime(localApp, { attachOnly: true })
    } catch (error) {
      lastFailure = error
    }
    await delay(250)
  }
  throw new Error('本机 BeefTV 尚未就绪，请检查桌面应用的启动提示后重新连接', { cause: lastFailure })
}

// Reconnects to a running desktop App without opening it again.
export async function attachLocalRuntime() {
  await requireLocalApp()
  return launchRuntime(localApp, { attachOnly: true })
}

// The standalone workspace only ever runs the runtime bundled with the plugin.
export async function startRuntime(dataDir) {
  return launchRuntime(await bundledPaths(), { dataDir })
}

async function launchRuntime(paths, { dataDir, attachOnly = false }) {
  const args = ['--harness-runtime']
  if (attachOnly) args.push('--harness-attach-only')
  if (dataDir) args.push('--data-dir', dataDir)
  const child = spawn(paths.executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  // Runtime logs stay out of model output and the browser. Readiness is the only stdout record.
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  let ready = false
  const record = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('启动 BeefTV 超过 30 秒，请检查安装与工作区状态'))
    }, attachOnly ? 3_000 : 30_000)
    const fail = () => {
      if (ready) return
      clearTimeout(timer)
      reject(new Error('BeefTV 运行时启动失败，请确认安装完整且工作区未被旧版本占用'))
    }
    child.once('error', fail)
    child.once('exit', fail)
    lines.on('line', line => {
      if (ready) return
      try {
        const value = runtimeRecord(JSON.parse(line))
        ready = true
        clearTimeout(timer)
        resolve(value)
      } catch {
        // Go/native startup notices are not readiness records.
      }
    })
  }).catch(error => {
    lines.close()
    child.stdin.end()
    child.kill('SIGTERM')
    throw error
  })
  return {
    ...record, cli: paths.cli, child,
    close() {
      lines.close()
      child.stdin.end()
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          if (record.owned) child.kill('SIGTERM')
          resolve()
        }, record.owned ? 10_000 : 1_000)
        timer.unref()
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

export async function workspaceJSON(runtime, path, options = {}) {
  const response = await fetch(`${runtime.bridgeURL}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', 'X-Beeftv-Harness-Token': runtime.bridgeToken, ...options.headers },
  })
  const value = await response.json()
  if (!response.ok || value.code !== 0) throw new Error(value.msg || `BeefTV 请求失败 (${response.status})`)
  return value.data
}

export async function inspectWorkspace(runtime) {
  const [health, bootstrap] = await Promise.all([
    workspaceJSON(runtime, '/api/health'),
    workspaceJSON(runtime, '/api/workspace/bootstrap'),
  ])
  if (!health.ready || !health.schema?.ready || !health.build?.version || !bootstrap.workspace?.id) {
    throw new Error('BeefTV 工作区尚未就绪，请在本机应用中完成启动后重试')
  }
  if (String(runtime.version).replace(/^v/, '') !== health.build.version.replace(/^v/, '')) {
    throw new Error('BeefTV 连接版本已变化，请重新连接')
  }
  return {
    build: health.build,
    workspace: { id: bootstrap.workspace.id, name: bootstrap.workspace.name, storage: bootstrap.workspace.storage },
    contractVersion: bootstrap.contractVersion,
  }
}

// 直接走工作区操作层，带插件登记得到的客户端凭据；不经过模型，也不新增付费任务。
export async function callOperation(runtime, id, params, signal) {
  const response = await fetch(`${runtime.baseURL}/ops/${encodeURIComponent(id)}`, {
    method: 'POST',
    signal: signal ?? AbortSignal.timeout(25_000),
    headers: {
      'content-type': 'application/json',
      'X-Beeftv-Client': runtime.clientId,
      authorization: `Bearer ${runtime.clientToken}`,
    },
    body: JSON.stringify({ opId: randomUUID(), params }),
  })
  const value = await response.json()
  if (!response.ok || value.code !== 0) throw new Error(value.msg || `BeefTV 请求失败 (${response.status})`)
  return value.data
}

export function hasOperation(runtime, id) {
  return Array.isArray(runtime?.operations) && runtime.operations.some(operation => operation?.id === id)
}
