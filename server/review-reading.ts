import type { ContractReading } from './contract-reading.ts'
import type { DeskScenario, Fact } from './desk-dsl.ts'

// A vocabulary for messages and public views, not a second scenario catalogue.
// Unknown fields make the reading unavailable; the full contract remains accessible.
type Data = Record<string, unknown>
const object = (value: unknown): Data | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : null
const only = (data: Data, keys: string[]) => Object.keys(data).every(key => keys.includes(key))
const quote = (value: unknown) => `«${String(value)}»`
const references: Record<string, string> = {
  $key: 'указанный сценарий', $hash: 'согласованное содержание', $head: 'ревизия кода при согласовании',
  $thread: 'это обсуждение', $decisionThread: 'обсуждение выбранного решения', $decision: 'этот вопрос владельцу',
  $correction: 'коммит исправления', $choiceCommit: 'коммит выбранного исправления',
  $decisionCommit: 'коммит решения', $retriedCommit: 'коммит повторной записи решения', $recordedCommit: 'ранее сохраненный коммит решения',
}
const ref = (value: unknown) => typeof value === 'string' ? references[value] ?? quote(value) : null

function scope(value: unknown): string | null {
  const data = object(value)
  if (!data || !only(data, ['kind', 'key'])) return null
  return data.kind === 'change' ? 'изменение целиком' : data.kind === 'scenario' && ref(data.key) ? String(ref(data.key)) : null
}
function recorded(value: unknown): string | null {
  if (value === null) return 'Запись решения еще не подтверждена.'
  const data = object(value)
  if (!data || !only(data, ['how', 'commit']) || !ref(data.commit)) return null
  const how = data.how === 'patch' ? 'исправлением сценария' : data.how === 'decisions_md' ? 'в журнале решений' : null
  return how ? `Решение зафиксировано ${how}; подтвержден ${ref(data.commit)}.` : null
}
function patch(value: unknown): string | null {
  const data = object(value)
  if (!data || !only(data, ['state', 'commit'])) return null
  const states: Record<string, string> = { proposed: 'Исправление остается предложением', applying: 'Применение исправления ожидает подтверждения', applied: 'Исправление применено', stale: 'Прежнее исправление устарело' }
  const state = states[String(data.state)]
  if (!state) return null
  return `${state}${data.commit === null ? '; подтвержденного коммита нет' : data.commit !== undefined ? `; сохранен ${ref(data.commit)}` : ''}.`
}
function message(value: unknown): string | null {
  const data = object(value)
  if (!data || !only(data, ['role', 'text', 'patch', 'resolves'])) return null
  const parts: string[] = []
  if (data.role !== undefined || data.text !== undefined) {
    const role = data.role === 'owner' ? 'Владелец' : data.role === 'agent' ? 'Агент' : data.role === undefined ? 'Сообщение' : null
    if (!role || data.text !== undefined && typeof data.text !== 'string') return null
    parts.push(data.text !== undefined ? `${role}: ${quote(data.text)}` : data.role === 'owner' ? 'Сообщение владельца' : data.role === 'agent' ? 'Ответ агента' : role)
  }
  if (data.resolves !== undefined) {
    if (!Array.isArray(data.resolves) || data.resolves.some(id => !ref(id))) return null
    parts.push(`Связанные вопросы: ${data.resolves.map(ref).join(', ')}`)
  }
  if (data.patch !== undefined) { const text = patch(data.patch); if (!text) return null; parts.push(text) }
  return parts.join('. ')
}
const threadStates: Record<string, string> = { open: 'Обсуждение открыто.', answered: 'В обсуждении получен ответ агента.', resolved: 'Обсуждение закрыто.' }
function thread(value: unknown): string[] | null {
  const data = object(value)
  if (!data || !only(data, ['id', 'anchor', 'ref', 'status', 'messages'])) return null
  const lines: string[] = []
  if (data.id !== undefined) { if (!ref(data.id)) return null; lines.push('Ссылка на обсуждение сохранена.') }
  if (data.anchor !== undefined || data.ref !== undefined) {
    if (data.anchor !== 'scenario' && data.anchor !== 'change' || !ref(data.ref)) return null
    lines.push(`Обсуждение связано с ${data.anchor === 'scenario' ? 'указанным сценарием' : 'изменением целиком'}.`)
  }
  if (data.status !== undefined) { const text = threadStates[String(data.status)]; if (!text) return null; lines.push(text) }
  if (data.messages !== undefined) {
    if (!Array.isArray(data.messages)) return null
    const messages = data.messages.map(message)
    if (messages.some(item => item === null)) return null
    lines.push(messages.length ? `История сообщений по порядку: ${messages.join(' → ')}` : 'История сообщений пуста.')
  }
  return lines
}
function choice(value: unknown): string | null {
  const data = object(value)
  return data && only(data, ['note']) && typeof data.note === 'string' ? `Сохранен выбор владельца: ${quote(data.note)}.` : null
}
function decision(value: unknown): string[] | null {
  const data = object(value)
  if (!data || !only(data, ['status', 'recorded', 'choice', 'scope', 'dismissed'])) return null
  const lines: string[] = []
  if (data.status !== undefined) {
    const states: Record<string, string> = { decided: 'Выбор сделан, запись решения еще не завершена.', recorded: 'Решение владельца записано.', dismissed: 'Вопрос отклонен владельцем.' }
    const text = states[String(data.status)]; if (!text) return null
    if (data.status !== 'recorded' || !object(data.recorded)) lines.push(text)
  }
  if (data.recorded !== undefined) { const text = recorded(data.recorded); if (!text) return null; if (data.recorded !== null || data.status !== 'decided') lines.push(text) }
  if (data.choice !== undefined) { const text = choice(data.choice); if (!text) return null; lines.push(text) }
  if (data.scope !== undefined) { const text = scope(data.scope); if (!text) return null; lines.push(`Область вопроса: ${text}.`) }
  if (data.dismissed !== undefined) {
    const dismissed = object(data.dismissed)
    if (!dismissed || !only(dismissed, ['reason']) || typeof dismissed.reason !== 'string') return null
    lines.push(`Причина отклонения: ${quote(dismissed.reason)}.`)
  }
  return lines
}
function publicState(value: unknown): string[] | null {
  const data = object(value)
  if (!data || !only(data, ['review', 'decisions', 'decisionLog', 'features', 'readiness'])) return null
  const lines: string[] = []
  if (data.review !== undefined) {
    const review = object(data.review)
    if (!review || !only(review, ['threads']) || !Array.isArray(review.threads)) return null
    for (const item of review.threads) { const text = thread(item); if (!text) return null; lines.push(...text) }
  }
  if (data.decisions !== undefined) {
    if (!Array.isArray(data.decisions)) return null
    for (const item of data.decisions) { const text = decision(item); if (!text) return null; lines.push(...text) }
  }
  if (data.decisionLog !== undefined) {
    if (!Array.isArray(data.decisionLog)) return null
    if (!data.decisionLog.length) lines.push('В читаемом журнале решений нет записей.')
    for (const item of data.decisionLog) {
      const entry = object(item)
      if (!entry || !only(entry, ['question', 'note']) || Object.values(entry).some(v => typeof v !== 'string')) return null
      lines.push(`Запись в журнале решений: ${entry.question !== undefined ? `${quote(entry.question)} - ` : ''}${entry.note !== undefined ? quote(entry.note) : ''}.`)
    }
  }
  if (data.features !== undefined) {
    if (!Array.isArray(data.features)) return null
    for (const item of data.features) {
      const feature = object(item)
      if (!feature || !only(feature, ['scenarios']) || !Array.isArray(feature.scenarios)) return null
      for (const item of feature.scenarios) {
        const scenario = object(item), effective = object(scenario?.effective)
        if (!scenario || !only(scenario, ['effective']) || !effective || !only(effective, ['status', 'changedSinceApproval'])) return null
        if (effective.status !== 'pending' || effective.changedSinceApproval !== true) return null
        lines.push('Содержание сценария изменилось; требуется новое согласование владельца.')
      }
    }
  }
  if (data.readiness !== undefined) {
    const readiness = object(data.readiness)
    if (!readiness || !only(readiness, ['ready']) || typeof readiness.ready !== 'boolean') return null
    lines.push(readiness.ready ? 'Изменение готово к реализации.' : 'Изменение пока не готово к реализации.')
  }
  return lines
}
function given(fact: Fact): string | null {
  const [name, data] = Object.entries(fact)[0]!
  switch (name) {
    case 'ScenarioDiscovered': return only(data, ['file']) && (data.file === undefined || typeof data.file === 'string') ? data.file ? `Есть еще один сценарий из ${quote(data.file)}.` : 'В Desk есть сценарий для согласования.' : null
    case 'ScenarioApproved': return only(data, ['key', 'hash', 'commit']) && data.key === '$key' && data.hash === '$hash' && data.commit === '$head' ? 'Владелец уже согласовал текущую версию сценария.' : null
    case 'DiscussionAnswered':
      if (!only(data, ['text', 'answer', 'patch']) || data.patch !== undefined && data.patch !== true && data.patch !== 'stale' || data.text !== undefined && typeof data.text !== 'string' || data.answer !== undefined && typeof data.answer !== 'string') return null
      return data.patch === 'stale' ? 'Агент предложил исправление по прежней версии файла; после изменения файла патч больше не применяется.' : data.patch ? 'В обсуждении агент предложил исправление сценария.' : `В обсуждении уже получен ответ.${data.text !== undefined ? ` Вопрос: ${quote(data.text)}.` : ''}${data.answer !== undefined ? ` Ответ агента: ${quote(data.answer)}.` : ''}`
    case 'AgentReplyPrepared':
      if (!only(data, ['answer', 'patch', 'resolves']) || data.answer !== undefined && typeof data.answer !== 'string' || data.patch !== undefined && data.patch !== true || data.resolves !== undefined && (!Array.isArray(data.resolves) || data.resolves.some(v => !ref(v)))) return null
      return `Подготовлен ${data.patch ? 'ответ агента с предложением исправления' : 'ответ агента'}${data.answer !== undefined ? `: ${quote(data.answer)}` : ''}${data.resolves !== undefined ? `; он относится к вопросам: ${(data.resolves as unknown[]).map(ref).join(', ')}` : ''}.`
    case 'DiscussionClosed': return only(data, []) ? 'Обсуждение уже закрыто.' : null
    case 'ReviewThreadOpened': return only(data, ['id', 'anchor', 'ref', 'status']) && typeof data.id === 'string' && data.anchor === 'change' && data.ref === '' && data.status === 'open' ? 'Отдельно открыто другое обсуждение всего изменения.' : null
    case 'ReviewProjectionUnavailable': return only(data, []) ? 'Сохраненные представления обсуждений и журнала решений недоступны, но история событий сохранилась.' : null
    case 'GitCommitUnavailable': return only(data, []) ? 'Git временно не может сохранить коммит.' : null
    case 'GitCommitAvailable': return only(data, []) ? 'Git снова может сохранить коммит.' : null
    case 'DecisionRaised': {
      if (!only(data, ['question', 'scope']) || data.question !== undefined && typeof data.question !== 'string') return null
      const target = data.scope === undefined ? '' : scope(data.scope)
      return target === null ? null : `Открыт вопрос владельцу${target ? `; область: ${target}` : ''}${data.question !== undefined ? `: ${quote(data.question)}` : ''}.`
    }
    case 'ScenarioDecisionChosen': case 'OwnerChoiceRecorded': case 'OwnerChoiceRecordingPending': {
      if (!only(data, ['note']) || typeof data.note !== 'string') return null
      const state = name === 'ScenarioDecisionChosen' ? 'Выбор по сценарию сделан' : name === 'OwnerChoiceRecorded' ? 'Решение уже записано в журнале' : 'Выбор сохранен, но коммит решения еще ожидает записи'
      return `${state}: ${quote(data.note)}.`
    }
    case 'OwnerDecisionReattached': return only(data, ['to']) && ref(data.to) ? 'Вопрос владельцу перенесен на другой сценарий.' : null
    default: return null
  }
}
function event(fact: Fact): string | null {
  const [name, data] = Object.entries(fact)[0]!
  const empty: Record<string, string> = {
    ExecutionQueued: 'Работа агента поставлена в очередь.', ExecutionAttemptRequested: 'Запрошен запуск агента.',
    ExecutionAttemptObserved: 'Запуск агента подтвержден.', ExecutionReceiptAccepted: 'Результат работы агента принят.',
    ReviewAgentSessionSet: 'Сессия агента сохранена.', GitEffectPending: 'Запись в Git ожидает подтверждения.',
  }
  if (name in empty) return only(data, []) ? empty[name]! : null
  switch (name) {
    case 'DiscussionResolved': return only(data, ['threadId']) && ref(data.threadId) ? 'Обсуждение закрыто.' : null
    case 'DiscussionOpened': { const lines = only(data, ['thread']) ? thread(data.thread) : null; return lines ? `Открыто обсуждение. ${lines.filter(line => line !== threadStates.open).join(' ')}` : null }
    case 'DiscussionOwnerReplied': case 'DiscussionAgentReplied': {
      if (!only(data, ['threadId', 'message', 'status']) || !ref(data.threadId)) return null
      const text = message(data.message), status = data.status === undefined ? '' : threadStates[String(data.status)]
      return text === null || status === undefined ? null : `${text}.${status ? ` ${status}` : ''}`
    }
    case 'ExecutionSettled': return only(data, ['outcome']) && data.outcome === 'done' ? 'Работа агента завершена.' : null
    case 'GitEffectRequested': {
      const effect = object(data.effect), purpose = object(effect?.purpose)
      if (!only(data, ['effect']) || !effect || !only(effect, ['purpose']) || !purpose || !only(purpose, ['kind', 'ref'])) return null
      if (purpose.ref !== undefined && !ref(purpose.ref)) return null
      return purpose.kind === 'review-patch' ? 'Запрошен коммит исправления сценария.' : purpose.kind === 'record-decision' ? 'Запрошен коммит решения владельца.' : null
    }
    case 'GitEffectCompleted': return only(data, ['commit']) && ref(data.commit) ? `Коммит подтвержден: ${ref(data.commit)}.` : null
    case 'PatchApplicationRequested': case 'PatchApplicationPending': case 'PatchApplied':
      if (!only(data, ['threadId', 'index', 'commit']) || !ref(data.threadId) || !Number.isInteger(data.index)) return null
      return name === 'PatchApplicationRequested' ? 'Запрошено применение предложенного исправления.' : name === 'PatchApplicationPending' ? 'Применение исправления остается неподтвержденным.' : ref(data.commit) ? `Исправление применено; сохранен ${ref(data.commit)}.` : null
    case 'OwnerDecisionChosen': {
      if (!only(data, ['decisionId', 'choice']) || !ref(data.decisionId)) return null
      return data.choice === undefined ? 'Выбор владельца сохранен.' : choice(data.choice)
    }
    case 'OwnerDecisionRecorded': {
      if (!only(data, ['decisionId', 'recorded']) || !ref(data.decisionId)) return null
      return recorded(data.recorded)
    }
    case 'OwnerDecisionDismissed': return only(data, ['decisionId', 'reason']) && ref(data.decisionId) && typeof data.reason === 'string' ? `Вопрос отклонен. Причина: ${quote(data.reason)}.` : null
    default: return null
  }
}
function command(fact: Fact): { title: string; when: string } | null {
  const [name, data] = Object.entries(fact)[0]!
  switch (name) {
    case 'OpenDiscussion': return only(data, ['anchor', 'ref', 'text']) && data.anchor === 'scenario' && ref(data.ref) && typeof data.text === 'string' ? { title: 'Обсудить сценарий с агентом', when: `Владелец задает вопрос по сценарию: ${quote(data.text)}.` } : null
    case 'ResolveDiscussion': return only(data, ['thread']) && ref(data.thread) ? { title: 'Закрыть обсуждение после ответа агента', when: 'Владелец закрывает обсуждение.' } : null
    case 'ReplyToDiscussion': return only(data, ['thread', 'text']) && ref(data.thread) && typeof data.text === 'string' ? { title: 'Продолжить обсуждение уточняющим вопросом', when: `Владелец пишет в том же обсуждении: ${quote(data.text)}.` } : null
    case 'ApplyReviewPatch': return only(data, ['thread', 'summary']) && ref(data.thread) && typeof data.summary === 'string' ? { title: 'Применить согласованное исправление', when: `Владелец применяет предложенное исправление с описанием: ${quote(data.summary)}.` } : null
    case 'RefreshReviewPatch': return only(data, ['thread', 'index']) && ref(data.thread) && Number.isInteger(data.index) ? { title: 'Обновить устаревший патч без применения', when: 'Владелец запрашивает у агента новый патч по текущим файлам.' } : null
    case 'DecideOwnerQuestion': return only(data, ['id', 'note']) && ref(data.id) && typeof data.note === 'string' ? { title: 'Сохранить решение владельца', when: `Владелец отвечает на вопрос: ${quote(data.note)}.` } : null
    case 'DismissOwnerQuestion': return only(data, ['id', 'reason']) && ref(data.id) && typeof data.reason === 'string' ? { title: 'Отклонить вопрос с указанием причины', when: `Владелец отклоняет вопрос с причиной: ${quote(data.reason)}.` } : null
    case 'ReadChange': return only(data, []) ? { title: 'Восстановить состояние из истории событий', when: 'Владелец открывает состояние изменения.' } : null
    default: return null
  }
}

export function readReviewScenario(scenario: DeskScenario): ContractReading | undefined {
  // Select this vocabulary by domain messages, never by scenario ID or title.
  if (!scenario.given.some(fact => Object.keys(fact).some(name => ['DiscussionAnswered', 'DecisionRaised', 'AgentReplyPrepared'].includes(name)))) return
  if (scenario.cases || scenario.then.stream && scenario.then.stream !== 'review') return
  const action = command(scenario.when), conditions = scenario.given.map(given), events = scenario.then.events.map(event)
  if (!action || conditions.some(line => line === null) || events.some(line => line === null)) return
  if (scenario.then.bind && Object.entries(scenario.then.bind).some(([name, path]) => !references[`$${name}`] || !['response.body.id', 'response.body.threadId', 'response.body.commit'].includes(path))) return
  const then: string[] = []
  // Runtime lifecycle events stay in the executable details; summarize only those actually present.
  const runtime: string[] = []
  scenario.then.events.forEach((fact, index) => {
    if (Object.keys(fact)[0]!.startsWith('Execution') || 'ReviewAgentSessionSet' in fact) runtime.push(events[index]!)
    else if ('GitEffectCompleted' in fact && scenario.then.events.some(other => object(other.PatchApplied ?? other.OwnerDecisionRecorded)?.commit === fact.GitEffectCompleted!.commit || object(object(other.OwnerDecisionRecorded)?.recorded)?.commit === fact.GitEffectCompleted!.commit)) return
    else if ('GitEffectPending' in fact && scenario.then.events.some(other => 'PatchApplicationPending' in other)) return
    else then.push(events[index]!)
  })
  const lifecycle = ['ExecutionQueued', 'ExecutionAttemptRequested', 'ExecutionAttemptObserved', 'ExecutionReceiptAccepted', 'ExecutionSettled']
  if (runtime.length) then.push(lifecycle.every(name => scenario.then.events.some(fact => name in fact)) ? 'Агент выполнил запрос; запуск и результат работы подтверждены.' : runtime.join(' '))
  if (!events.length) then.push('Новых событий в журнале согласования нет.')
  const response = scenario.then.response, body = object(response.body)
  if (response.status >= 400) {
    const error = object(body?.error)
    const reasons: Record<string, string> = {
      patch_application_pending: 'Исправление пока не подтверждено: запись коммита не завершена.',
      git_effect_pending: 'Решение пока не записано: коммит ожидает подтверждения.',
      patch_decision_changed: 'Старое исправление отклонено: вопрос теперь относится к другому сценарию.',
    }
    if (!body || !only(body, ['error']) || !error || !only(error, ['code']) || !reasons[String(error.code)]) return
    then.push(reasons[String(error.code)]!)
    action.title = error.code === 'patch_decision_changed' ? 'Не применять старое исправление после переноса вопроса' : error.code === 'git_effect_pending' ? 'Сохранить выбор при сбое записи решения' : 'Сохранить исправление неподтвержденным при сбое Git'
  } else if (!('ReadChange' in scenario.when)) {
    if (![200, 201, 202].includes(response.status) || response.body !== undefined && (!body || !only(body, ['ok', 'status', 'threadId', 'commit']))) return
    if (body?.ok !== undefined && body.ok !== true || body?.threadId !== undefined && !ref(body.threadId) || body?.commit !== undefined && !ref(body.commit)) return
    if (body?.status !== undefined) {
      if (body.status !== 'recorded' && body.status !== 'decided') return
      then.push(body.status === 'recorded' ? 'Desk подтверждает запись решения.' : 'Desk подтверждает выбор; запись решения еще не завершена.')
    }
    if (response.status === 202) then.push('Запрос принят для выполнения.')
  } else if (response.status !== 200) return
  const observations: string[] = []
  if ('ReadChange' in scenario.when && response.body !== undefined) {
    const text = publicState(response.body); if (!text) return
    observations.push(...text)
  }
  for (const read of scenario.then.reads ?? []) {
    if (read.path !== '$change' || read.response.status !== 200) return
    const text = publicState(read.response.body); if (!text) return
    observations.push(...text)
  }
  if ('ReadChange' in scenario.when) action.title = observations.some(line => line.includes('журнале решений')) ? 'Восстановить записанное решение и журнал из событий' : 'Восстановить закрытое обсуждение из событий'
  if ('DecideOwnerQuestion' in scenario.when && response.status < 400) action.title = body?.status === 'decided' ? 'Передать выбор по сценарию агенту для исправления' : scenario.given.some(fact => 'OwnerChoiceRecordingPending' in fact) ? 'Повторить запись решения без нового выбора' : 'Записать решение по изменению в журнал'
  if ('ApplyReviewPatch' in scenario.when && response.status < 400) action.title = scenario.then.events.some(fact => 'OwnerDecisionRecorded' in fact) ? 'Завершить решение после коммита исправления' : 'Применить исправление и запросить новое согласование'
  const observed = [...new Set(observations)].filter(line => !then.includes(line))
  return { title: action.title, given: conditions as string[], when: action.when, then, ...(observed.length ? { observations: observed } : {}) }
}
