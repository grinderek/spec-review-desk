import type { DeskScenario, Fact } from './desk-dsl.ts'
import { readReviewScenario } from './review-reading.ts'
import { readCatalogScenario } from './catalog-reading.ts'

// Message formatters, like ToString in the specification examples. The executable
// data remains authoritative; no scenario IDs or second set of expectations live here.
export type ReadingPart = string | { text: string; table?: string[][]; docString?: string; mediaType?: string }
export interface ContractReading {
  title: string
  given: ReadingPart[]
  when: ReadingPart | ReadingPart[]
  then: ReadingPart[]
  observations?: string[]
  variants?: { label: string; reading: Omit<ContractReading, 'variants'> }[]
}
export function processReading(file: string): { title: string; summary: string } | undefined {
  return ({
    'features/existing-process.desk.yaml': { title: 'Описание существующего процесса', summary: 'Исследование исходников продукта, проверяемые ссылки и согласование найденных правил' },
    'features/approval-status.desk.yaml': { title: 'Очередь согласования', summary: 'Подтвержденное согласование и возврат измененного пакета на проверку владельцу' },
    'features/multi-repository-verification.desk.yaml': { title: 'Общая проверка компонентов', summary: 'Привязка результата к исходникам каждого участвующего репозитория' },
    'features/product-onboarding.desk.yaml': { title: 'Подключение продукта', summary: 'Состав продукта, доступность компонентов и готовность проверок' },
    'features/scenario-approval.desk.yaml': { title: 'Согласование сценария', summary: 'Согласование, отзыв и изменение содержания' },
    'features/discussions.desk.yaml': { title: 'Обсуждения', summary: 'Вопросы агенту, исправления, закрытие и восстановление обсуждений' },
    'features/owner-decisions.desk.yaml': { title: 'Решения владельца', summary: 'Выбор, запись решения, исправления и восстановление после сбоев' },
    'features/initiatives.desk.yaml': { title: 'Инициативы и планирование', summary: 'Описание, этапы, согласование плана, исследования и материалы' },
    'features/initiative-creation.desk.yaml': { title: 'Создание инициативы', summary: 'Создание, повтор запроса и восстановление первоначального коммита' },
    'features/agent-usage.desk.yaml': { title: 'Использование агентов', summary: 'Токены, попытки выполнения и неизвестная стоимость' },
    'features/approval-recovery.desk.yaml': { title: 'Запись и восстановление согласования', summary: 'Коммит согласования, ошибки Git и повторная запись' },
    'features/execution-recovery.desk.yaml': { title: 'Восстановление работы агентов', summary: 'Ответы, остановка, неподтвержденные результаты и продолжение' },
    'features/implementation.desk.yaml': { title: 'Реализация и проверка', summary: 'Условия запуска, соответствие контрактам и результаты проверки' },
    'features/journal-recovery.desk.yaml': { title: 'Восстановление согласования', summary: 'Сохранение согласований и решений при потере представлений' },
    'features/native-contracts.desk.yaml': { title: 'Идентичность контрактов', summary: 'Корректность пакета, переименование и различие сценариев' },
    'features/review-actions.desk.yaml': { title: 'Согласование изменений и формулировок', summary: 'Запрос изменений, формулировки и связи записей согласования' },
    'features/review-readiness.desk.yaml': { title: 'Готовность к реализации', summary: 'Блокирующие решения, обсуждения и формулировки' },
    'features/verification-recovery.desk.yaml': { title: 'Проверки и восстановление результатов', summary: 'Версия кода, достоверность отчета, остановка и повтор проверки' },
  } as Record<string, { title: string; summary: string }>)[file]
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))

function describe(fact: Fact): string | null {
  const [name, data] = Object.entries(fact)[0]!
  switch (name) {
    case 'ScenarioDiscovered':
      return only(data, []) ? 'В Desk есть сценарий для согласования.' : null
    case 'ScenarioApproved':
      return only(data, ['key', 'hash', 'commit', 'at']) && data.key === '$key' && data.hash === '$hash' && data.commit === '$head'
        ? 'Сохранено согласование текущей версии сценария с привязкой к ревизии кода.' : null
    case 'ScenarioRevised':
      return only(data, ['status']) && typeof data.status === 'number' ? 'Содержание сценария изменилось после согласования.' : null
    case 'ScenarioReformatted':
      return only(data, []) ? 'Изменилось только оформление YAML, содержание сценария осталось прежним.' : null
    case 'ScenarioReviewRemoved':
      return only(data, ['key']) && data.key === '$key' ? 'Согласование сценария отозвано.' : null
    default: return null
  }
}

function readApprovalScenario(scenario: DeskScenario): ContractReading | undefined {
  const review = readReviewScenario(scenario)
  if (review) return review
  if (scenario.cases || scenario.then.bind || scenario.then.reads?.length || (scenario.then.stream && scenario.then.stream !== 'review')) return
  const given = scenario.given.map(describe)
  const events = scenario.then.events.map(describe)
  if (given.some(line => line === null) || events.some(line => line === null)) return
  const [command, data] = Object.entries(scenario.when)[0]!
  const response = scenario.then.response
  if (response.status !== 200) return
  let title: string, when: string
  const then = events as string[]
  if (command === 'ApproveScenario' || command === 'RevokeScenarioApproval') {
    if (!only(data, ['key']) || data.key !== '$key') return
    const body = record(response.body)
    if (!body || !only(body, ['ok']) || body.ok !== true) return
    title = command === 'ApproveScenario' ? 'Согласовать текущую версию сценария' : 'Отозвать согласование сценария'
    when = command === 'ApproveScenario' ? 'Владелец согласует сценарий.' : 'Владелец отзывает согласование.'
  } else if (command === 'ReadChange' && only(data, [])) {
    const body = record(response.body)
    const features = body?.features
    if (!body || !only(body, ['features', 'readiness']) || !Array.isArray(features) || features.length !== 1) return
    const feature = record(features[0]), scenarios = feature?.scenarios
    if (!feature || !only(feature, ['scenarios']) || !Array.isArray(scenarios) || scenarios.length !== 1) return
    const item = record(scenarios[0]), effective = record(item?.effective)
    if (!item || !only(item, ['effective']) || !effective || !only(effective, ['status', 'changedSinceApproval', 'approvedCommit']) || effective.approvedCommit !== '$head') return
    if (effective.status === 'pending' && effective.changedSinceApproval === true) {
      title = 'Измененный сценарий требует нового согласования'
      then.push('Сценарий снова ожидает согласования: его содержание изменилось.')
    } else if (effective.status === 'approved' && effective.changedSinceApproval === false) {
      title = 'Форматирование сохраняет согласование'
      then.push('Сценарий остается согласованным: его содержание не изменилось.')
    } else return
    then.push('Ссылка на ревизию предыдущего согласования сохранена.')
    if (body.readiness !== undefined) {
      const readiness = record(body.readiness)
      if (!readiness || !only(readiness, ['ready']) || typeof readiness.ready !== 'boolean') return
      then.push(readiness.ready ? 'Изменение готово к реализации.' : 'Изменение пока не готово к реализации.')
    }
    when = 'Владелец открывает состояние изменения.'
  } else return
  if (!scenario.then.events.length) then.push('Новых событий в журнале согласования нет.')
  return { title, given: given as string[], when, then }
}

export function readScenario(scenario: DeskScenario): ContractReading | undefined {
  return readApprovalScenario(scenario) ?? readCatalogScenario(scenario)
}
