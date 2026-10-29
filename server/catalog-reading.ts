import type { ContractReading } from './contract-reading.ts'
import type { DeskScenario, Fact } from './desk-dsl.ts'
import { caseNames, commands, conditions, errors, events, states } from './reading-vocabulary.ts'

type Data = Record<string, unknown>
const object = (value: unknown): Data | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : null
const own = <T>(map: Record<string, T>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined
const quote = (value: unknown) => `«${String(value).trimEnd()}»`
const references: Record<string, string> = {
  processWorktree: 'рабочая директория описания процесса',
  proposedChange: 'подготовленное предложение правил',
  key: 'этот сценарий', hash: 'согласованное содержание сценария', head: 'ревизия кода при согласовании', at: 'время согласования',
  phrase: 'эта формулировка', phraseHash: 'содержание формулировки', targetKey: 'указанный контракт', change: 'это изменение',
  initiative: 'эта инициатива', initiativeWorktree: 'рабочая директория созданной инициативы', creation: 'этот запрос создания',
  creationWorktree: 'рабочая директория созданной инициативы', initiativeEffect: 'ожидающий коммит инициативы',
  researchRun: 'это исследование', questionRun: 'эта работа над вопросом', applyRun: 'эта реализация',
  run: 'эта проверка', source: 'версия кода этой проверки', runner: 'состояние проверки',
  previousVerification: 'предыдущая проверка', verificationRerun: 'сохраненный запрос повторной проверки',
  approvalCommit: 'коммит согласования', newCommit: 'новый коммит согласования', approvalEffect: 'запись коммита согласования',
  thread: 'это обсуждение', decision: 'этот вопрос владельцу', decisionThread: 'обсуждение решения',
  correction: 'коммит исправления', choiceCommit: 'коммит выбранного исправления', decisionCommit: 'коммит решения',
  retriedCommit: 'коммит повторной записи решения', recordedCommit: 'сохраненный коммит решения',
}
const labels: Record<string, string> = {
  existingProcess: 'Описание существующего процесса', product: 'Продукт', process: 'Процесс', boundary: 'Границы процесса', snapshot: 'Снимок исходников', sources: 'Источники реализации', repo: 'Репозиторий', lines: 'Строк в исходном файле', rule: 'Правило', line: 'Строка реализации', end_line: 'Последняя строка реализации',
  processProduct: 'Продукт для исследования', processName: 'Название процесса', processBoundary: 'Границы исследования', processRepos: 'Компоненты для исследования',
  repos: 'Репозитории', worktrees: 'Рабочие директории', changes: 'Изменения', reviewStatus: 'Группа согласования',
  workerAvailable: 'Репозиторий обработчика доступен', products: 'Продукты', components: 'Компоненты',
  availability: 'Доступность', rules: 'Исполняемые правила', count: 'Количество', runner: 'Запуск проверки',
  text: 'Текст', answer: 'Ответ агента', usageReported: 'Агент сообщил расход токенов', method: 'Способ обращения', path: 'Адрес',
  totals: 'Итого', attempts: 'Попытки выполнения', completed: 'Завершено', unfinished: 'Не завершено', unknownUsage: 'Запуски без данных о токенах',
  actualBilledUsd: 'Фактически списано, USD', estimatedApiUsd: 'Оценка стоимости API, USD', usage: 'Расход токенов', role: 'Участник',
  routing: 'Выбор агента', source: 'Источник', key: 'Контракт', hash: 'Содержание', text_hash: 'Согласованное содержание', commit: 'Коммит',
  effect: 'Запись в Git', effectId: 'Ожидающий коммит', purpose: 'Назначение', kind: 'Вид работы', error: 'Причина отказа', code: 'Причина',
  thread: 'Обсуждение', threadId: 'Обсуждение', ok: 'Запрос выполнен', review: 'Согласование', threads: 'Обсуждения',
  status: 'Статус', messages: 'Сообщения по порядку', patch: 'Исправление', summary: 'Описание коммита', index: 'Номер ответа с исправлением',
  features: 'Правила продукта', scenarios: 'Сценарии', effective: 'Состояние согласования', changedSinceApproval: 'Содержание изменилось после согласования',
  state: 'Состояние', message: 'Сообщение', outcome: 'Итог работы', id: 'Идентификатор', anchor: 'Область обсуждения', ref: 'Связанный контракт',
  readiness: 'Готовность к реализации', ready: 'Можно начать реализацию', runId: 'Работа', executions: 'Выполнение', cause: 'Причина запуска',
  run: 'Работа', attempt: 'Попытка выполнения', apply_runs: 'Реализация', slices: 'Этапы', title: 'Название', scope: 'Содержание этапа или область вопроса',
  depends_on: 'Зависимости', change: 'Предложенное изменение', deliver: 'Реализация контрактов подготовлена', statuses: 'Состояние этапов',
  blockers: 'Препятствия для этапов', decisions: 'Решения владельца', request: 'Запрос', sourceHash: 'Версия исходного кода',
  sourceUnchanged: 'Исходный код не изменился во время проверки', report: 'Отчет проверки', execution: 'Способ выполнения',
  running: 'Работа выполняется', stale: 'Результат устарел', result: 'Результат', states: 'Соответствие реализации контрактам', drift: 'Расхождения',
  where: 'Рабочая директория', creationId: 'Запрос создания', creations: 'Запросы создания инициатив', name: 'Имя', fromRepo: 'Исходные файлы проекта',
  worktreeId: 'Рабочая директория', brief: 'Описание инициативы', inputs: 'Материалы', file: 'Файл', draft: 'Материал еще является черновиком',
  phase: 'Состояние создания', plan: 'План', operation: 'Изменение владельца', type: 'Событие выполнения', blockingDecisions: 'Блокирующие вопросы владельцу',
  slice: 'Этап', topic: 'Тема исследования', present: 'Материал доступен', choice: 'Выбор владельца', input: 'Материал', research: 'Исследование',
  domains: 'Разрешенные домены', runs: 'Работы агентов', web_fetch: 'Разрешено чтение источников', git_effects: 'Записи в Git', files: 'Файлы',
  question: 'Вопрос', option: 'Выбранный вариант', note: 'Ответ владельца', at: 'Время', mode: 'Условие', reviewErrors: 'Ошибки истории согласования',
  recorded: 'Запись решения', validation: 'Проверка пакета', valid: 'Пакет корректен', decisionId: 'Вопрос владельцу', how: 'Способ записи решения',
  decisionLog: 'Журнал решений', resolves: 'Вопросы, к которым относится ответ', reason: 'Причина', dismissed: 'Отклонение вопроса',
  to: 'Новый связанный контракт', extension: 'Расширение существующей формулировки', phrases: 'Формулировки', reasons: 'Причины блокировки',
  approved_commit: 'Ревизия согласования', section: 'Вид контракта', orphans: 'Записи без связанного контракта', blocking: 'Вопрос блокирует продолжение',
  approvedCommit: 'Ревизия согласования', passed: 'Успешно', failed: 'С ошибкой', other: 'Остальные результаты', requestId: 'Запрос повтора',
  queued: 'Повтор ожидает запуска', commandError: 'Результат остановки или ошибка команды',
}
const enums = new Set(['status', 'outcome', 'kind', 'mode', 'phase', 'operation', 'cause', 'anchor', 'role', 'section', 'how', 'execution', 'source', 'state', 'choice', 'where', 'availability'])
const nil = (key: string) => ['actualBilledUsd', 'estimatedApiUsd', 'usage'].includes(key) ? 'неизвестно' : key === 'commit' || key === 'recorded' ? 'не подтвержден' : key === 'result' ? 'не принят' : key === 'blockers' ? 'препятствий нет' : 'отсутствует'
function label(key: string): string | undefined {
  if (/^s\d+$/.test(key)) return `Этап ${key}`
  if (key.includes('::')) return `Контракт ${quote(key)}`
  if (key.startsWith('$')) return own(references, key.slice(1))
  return own(labels, key)
}
function scalar(value: unknown, key: string): string | null {
  if (value === null) return nil(key)
  if (typeof value === 'boolean') return value ? 'да' : 'нет'
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return null
  if (value.startsWith('$')) return own(references, value.slice(1)) ?? null
  if (key === 'type') return own(events, value) ?? null
  if (key === 'code') return own(errors, value) ?? null
  if (key === 'reason' || key === 'reasons') {
    const reasons: Record<string, string> = { '1 scenario not approved': 'один сценарий не согласован', '1 blocking decision open': 'одно блокирующее решение не завершено', '1 thread not resolved': 'одно обсуждение не закрыто', '1 phrase not approved': 'одна формулировка не согласована', 'Stopped by the owner': 'остановлено владельцем' }
    return own(reasons, value) ?? quote(value)
  }
  if (key === 'commandError' && value === 'Stopped by the owner') return 'остановлено владельцем'
  if (key === 'reviewStatus') return value === 'approved' ? 'согласовано' : value === 'pending' ? 'на согласовании' : null
  if (key === 'blockers' && /^waiting for s\d+$/.test(value)) return `ожидает этап ${value.slice('waiting for '.length)}`
  if (enums.has(key)) return own(states, value) ?? quote(value)
  return quote(value)
}
function describe(value: unknown, key = ''): string | null {
  if (Array.isArray(value)) {
    if (!value.length) return ['depends_on', 'blockers', 'reasons', 'drift'].includes(key) ? 'нет' : 'список пуст'
    if (key === 'slices') {
      const stages = value.map((item, index) => {
        const stage = object(item)
        if (!stage) return null
        const parts = Object.entries(stage).map(([field, v]) => {
          if (field === 'title') return quote(v)
          if (field === 'id') return `этап ${String(v)}`
          if (field === 'scope') return String(v)
          if (field === 'depends_on' && Array.isArray(v)) return v.length ? `зависит от этапов: ${v.join(', ')}` : 'без зависимостей'
          const name = label(field), text = describe(v, field)
          return name && text !== null ? `${name.toLowerCase()}: ${text}` : null
        })
        return parts.some(v => v === null) ? null : `${index + 1}. ${parts.join('; ')}`
      })
      return stages.some(v => v === null) ? null : stages.join(' / ')
    }
    const parts = value.map(v => describe(v, key))
    if (parts.some(v => v === null)) return null
    return parts.join(' / ')
  }
  const data = object(value)
  if (!data) return scalar(value, key)
  if (!Object.keys(data).length) return 'запись присутствует'
  if (key === 'plan') {
    const parts = Object.entries(data).map(([field, v]) => field === 'status' ? scalar(v, field) : label(field) && describe(v, field) !== null ? `${label(field)}: ${describe(v, field)}` : null)
    return parts.some(v => v === null) ? null : parts.join('; ')
  }
  if (key === 'readiness' && typeof data.ready === 'boolean' && Object.keys(data).every(k => ['ready', 'reasons'].includes(k))) {
    const reasons = data.reasons === undefined ? '' : describe(data.reasons, 'reasons')
    if (reasons === null) return null
    return `${data.ready ? 'можно начать реализацию' : 'реализацию начинать нельзя'}${reasons ? `; причины блокировки: ${reasons}` : ''}`
  }
  if (['statuses', 'states', 'blockers'].includes(key)) {
    const values = Object.entries(data).map(([field, v]) => {
      const name = label(field), text = describe(v, key === 'blockers' ? 'blockers' : key === 'states' ? 'state' : 'status')
      return name && text !== null ? `${name}: ${text}` : null
    })
    return values.some(v => v === null) ? null : values.join('; ')
  }
  const parts = Object.entries(data).map(([field, v]) => {
    if (field === 'doc') return describe(v)
    const name = label(field), text = describe(v, field)
    return name && text !== null ? `${name}: ${text}` : null
  })
  return parts.some(v => v === null) ? null : parts.join('; ')
}
function factText(fact: Fact, dictionary: Record<string, string>): string | null {
  const [name, payload] = Object.entries(fact)[0]!
  const text = own(dictionary, name)
  if (!text) return null
  if (!Object.keys(payload).length) return `${text}.`
  if (describe(payload) === null) return null
  // Validate the complete message, but leave transport identities in the executable details.
  const visible = Object.fromEntries(Object.entries(payload).filter(([key]) => !['creationId', 'runId', 'threadId', 'effectId', 'requestId', 'id', 'key', 'hash', 'at', 'sourceHash'].includes(key)))
  const details = Object.keys(visible).length ? describe(visible) : ''
  return details === null ? null : `${text}${details ? `. ${details}` : ''}.`
}
const has = (facts: Fact[], name: string) => facts.some(f => name in f)
const factData = (facts: Fact[], name: string): Data | undefined => facts.find(f => name in f)?.[name]

function title(s: DeskScenario, name: string, fallback: string): string {
  if (Object.values(s.when).some(value => value.processProduct) || s.given.some(f => f.InitiativeOpened?.processProduct)) return s.scenario
  if (name === 'ReadProducts' || name === 'ReadChangeSummary') return s.scenario
  const g = s.given, e = s.then.events
  const code = object(object(s.then.response.body)?.error)?.code
  if (name === 'ApprovePlan' && code) return 'Разрешить блокирующие вопросы перед согласованием плана'
  if (name === 'ProposeSlice') return code ? 'Дождаться готовности зависимостей этапа' : has(g, 'ApprovedSliceProposed') ? 'Предложить зависимый этап после согласования предыдущего' : 'Предложить этап как изменение для отдельного согласования'
  if (name === 'EditBrief' && code) return 'Сохранить описание инициативы при сбое коммита'
  if (name === 'OpenInitiative' && has(g, 'InitiativeCreationPrepared')) return 'Вернуть существующую инициативу при повторном запросе'
  if (name === 'RecoverInitiativeCreations') return factData(g, 'InitiativeCreationPrepared')?.phase === 'foreign' ? 'Оставить создание неподтвержденным при обнаружении чужой ветки' : has(e, 'InitiativeCreationCompleted') ? 'Подтвердить уже выполненное создание инициативы' : 'Наблюдать создание без запуска новых действий'
  if (name === 'RetryInitiativeCreation') return factData(g, 'InitiativeCreationPrepared')?.phase === 'pending' ? 'Завершить первоначальный коммит без второй инициативы' : 'Продолжить создание с сохраненным описанием и материалами'
  if (name === 'ReconcileInitiativeRuns') {
    if (has(g, 'OwnerPlanRevised')) return 'Сохранить правки владельца при восстановлении плана'
    if (has(g, 'InitiativeBriefCommitUnacknowledged')) return 'Подтвердить уже сохраненный коммит описания инициативы'
    return has(g, 'InitiativeReceiptUnavailable') ? 'Ожидать решения владельца при неподтвержденном исследовании' : 'Восстановить результат исследования без повторного запуска агента'
  }
  if (name === 'ResumeResearch' && has(g, 'ResearchPermissionRecorded')) return 'Продолжить исследование с разрешениями владельца'
  if (name === 'ResumeResearch' && has(g, 'ResearchOutcomeUnknown')) return 'Начать новую попытку исследования по явному решению владельца'
  if (name === 'ReadChange') {
    if (has(g, 'ReviewProjectionDamaged')) return 'Сохранить согласование и незавершенное решение при потере представления'
    if (has(g, 'ScenarioRetitled')) return 'Сохранить обсуждение при переименовании сценария и запросить новое согласование'
    if (g.filter(f => 'ScenarioDiscovered' in f).length > 1) return 'Различать одноименные сценарии в разных папках'
    if (has(g, 'DecisionRaised')) return 'Учитывать только незавершенные блокирующие решения'
    if (has(g, 'ReviewThreadOpened')) return 'Закрывать обсуждения согласования перед началом реализации'
    if (has(g, 'PhraseProposed')) return 'Требовать согласования всех предложенных формулировок'
  }
  if (name === 'RecordChangeApproval') {
    if (has(g, 'ChangeApprovalCompleted')) return 'Вернуть существующий коммит при повторном согласовании'
    if (has(g, 'ApprovalCommitFailed')) return 'Повторить запись коммита без нового согласования владельца'
    if (has(g, 'ApprovalCommitRejected')) return 'Сохранить согласование при отказе Git'
    if (has(g, 'ChangeMetadataChanged')) return 'Не согласовывать изменение с некорректной декларацией пакета'
    if (code === 'execution_pending') return 'Дождаться подтверждения предыдущей проверки перед коммитом согласования'
    if (code === 'not_ready') return 'Не записывать согласование при невыполненных условиях'
  }
  if (name === 'RecoverApproval' && has(g, 'ApprovalRecovered')) return 'Не создавать повторный коммит при восстановлении согласования'
  if (name === 'StartApply') {
    if (has(g, 'ApprovedSliceProposed')) return 'Считать этап реализованным только при совпадении контрактов'
    if (has(g, 'ScenarioRevised')) return 'Потребовать новое согласование после изменения контракта'
    if (code === 'approval_not_recorded') return 'Записать согласование перед началом реализации'
    if (code === 'approval_not_committed') return 'Подтвердить коммит согласования перед реализацией'
    if (code === 'execution_pending') return 'Не начинать реализацию при неподтвержденной предыдущей работе'
  }
  if (name === 'ResumeApply' && has(g, 'ApplyStopped')) return 'Продолжить остановленную реализацию новой попыткой'
  if (name === 'RecoverExecutions') return has(g, 'QuestionRecovered') ? 'Не дублировать восстановленный ответ и попытку выполнения' : has(e, 'ExecutionUncertain') ? 'Показать неподтвержденный результат предыдущего ответа' : 'Восстановить сохраненный ответ агента без повторного запуска'
  if (name === 'RunVerification') return code === 'apply_running' ? 'Дождаться реализации перед проверкой в той же директории' : has(e, 'VerificationReportRejected') ? 'Отклонить неполный отчет или результат другой версии' : fallback
  if (name === 'RestartVerification') return has(g, 'VerificationRerunPending') ? 'Восстановить сохраненный запрос повторной проверки' : has(g, 'VerificationProjectionLost') ? 'Восстановить результат проверки из истории' : 'Принять завершенную проверку без повторного запуска'
  return fallback
}
const streamNames: Record<string, string> = { review: 'согласования', initiative: 'инициативы', verification: 'проверки', worktree: 'рабочей директории' }
function one(s: DeskScenario): ContractReading | undefined {
  const [name, data] = Object.entries(s.when)[0]!, action = own(commands, name)
  if (!action) return
  const given = s.given.map(f => factText(f, conditions)), expected = s.then.events.map(f => factText(f, events))
  if (given.some(v => v === null) || expected.some(v => v === null)) return
  const params = Object.keys(data).length ? describe(data) : ''
  if (params === null) return
  const then: string[] = []
  const runtime: string[] = []
  s.then.events.forEach((fact, index) => {
    const name = Object.keys(fact)[0]!
    if (name.startsWith('Execution') || name === 'InitiativeExecutionRecorded' || name === 'InitiativeRunParametersSelected' || name === 'ReviewAgentSessionSet') runtime.push(expected[index]!)
    else then.push(expected[index]!)
  })
  if (runtime.length) {
    const result = s.then.events.flatMap(f => 'InitiativeExecutionRecorded' in f ? [object(f.InitiativeExecutionRecorded!.execution)] : 'ExecutionSettled' in f ? [f.ExecutionSettled] : []).filter(Boolean)
    const outcomes = result.map(r => r?.outcome).filter(v => v !== undefined)
    const outcome = outcomes.at(-1)
    // A compact reading of the actual lifecycle, without claiming completion for a queued attempt.
    if (outcome !== undefined) {
      if (!s.then.events.some(f => f.InitiativeRunOutcomeRecorded?.outcome === outcome)) then.push(`Работа агента или проверки: ${scalar(outcome, 'outcome')}.`)
    }
    else if (s.then.events.some(f => 'ExecutionUncertain' in f || object(f.InitiativeExecutionRecorded?.execution)?.type === 'ExecutionUncertain')) then.push('Результат выполнения остается неподтвержденным.')
    else then.push(runtime.join(' '))
  }
  if (!s.then.events.length) then.push(`Новых событий в журнале ${streamNames[s.then.stream ?? 'review']} нет.`)
  const response = object(s.then.response.body), error = object(response?.error)
  if (s.then.response.status >= 400) {
    const reason = error && typeof error.code === 'string' ? own(errors, error.code) : undefined
    if (!reason) return
    then.push(`Desk отклоняет действие. ${reason}.`)
  }
  const observations: string[] = []
  const body = s.then.response.body
  if (body !== undefined && !error) {
    if (response && Object.keys(response).length === 1 && response.ok === true) {
      if (!then.length) then.push('Desk подтверждает выполнение запроса.')
    } else {
      const text = describe(body)
      if (text === null) return
      observations.push(text)
    }
  }
  for (const read of s.then.reads ?? []) {
    const target = read.path === '$initiative' || read.path.startsWith('/api/initiatives/') ? 'Инициатива' : read.path === '$runner' ? 'Проверка реализации' : read.path.startsWith('/api/initiative-creations/') ? 'Создание инициативы' : 'Изменение'
    if (read.response.status >= 400) { const text = describe(read.response.body); if (text === null) return; observations.push(`${target}: запрос отклонен. ${text}`); continue }
    const text = read.response.body === undefined ? 'запрос выполнен' : describe(read.response.body)
    if (text === null) return
    observations.push(`${target}: ${text}.`)
  }
  return { title: title(s, name, action.title), given: given as string[], when: `${action.action}${params ? `. ${params}` : ''}.`, then, ...(observations.length ? { observations } : {}) }
}
function substitute(value: unknown, vars: Data): unknown {
  if (typeof value === 'string') {
    if (/^\$[a-zA-Z0-9]+$/.test(value) && Object.hasOwn(vars, value.slice(1))) return vars[value.slice(1)]
    return value.replace(/\$([a-zA-Z0-9]+)/g, (match, key: string) => Object.hasOwn(vars, key) && typeof vars[key] !== 'object' ? String(vars[key]) : match)
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, vars))
  const data = object(value)
  return data ? Object.fromEntries(Object.entries(data).map(([key, v]) => [String(substitute(key, vars)), substitute(v, vars)])) : value
}
export function readCatalogScenario(scenario: DeskScenario): ContractReading | undefined {
  if (!scenario.cases) return one(scenario)
  const variants = scenario.cases.map((row, index) => {
    const { cases: _cases, ...template } = scenario
    const reading = one(substitute(template, row) as DeskScenario)
    return reading ? { label: typeof row.name === 'string' ? own(caseNames, row.name) ?? row.name : `Вариант ${index + 1}`, reading } : null
  })
  if (variants.some(v => v === null)) return
  return { ...variants[0]!.reading, variants: variants as NonNullable<ContractReading['variants']> }
}
