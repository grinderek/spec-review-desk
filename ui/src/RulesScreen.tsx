import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from './api.ts'
import { ContractDetails, ContractReading } from './ContractReading.tsx'
import type { Selection } from './selection.ts'
import { processReading } from '../../server/contract-reading.ts'

const ruleCount = (n: number) => `${n} ${n % 100 >= 11 && n % 100 <= 14 ? 'правил' : n % 10 === 1 ? 'правило' : n % 10 >= 2 && n % 10 <= 4 ? 'правила' : 'правил'}`

export function RulesScreen({ wt, file, onSelect }: { wt: string; file?: string; onSelect: (selection: Selection) => void }) {
  const corpus = useQuery({ queryKey: ['rules', wt], queryFn: () => api.rules(wt) })
  const runner = useQuery({ queryKey: ['runner', wt], queryFn: () => api.runner(wt) })
  const run = useMutation({ mutationFn: () => api.runCorpus(wt), onSettled: () => { void runner.refetch() } })
  if (corpus.isLoading) return <p className="empty">Загружаем действующие правила...</p>
  if (corpus.error || !corpus.data) return <p className="banner bad">{corpus.error instanceof Error ? corpus.error.message : 'Не удалось загрузить правила'}</p>
  const { features, errors } = corpus.data
  const selectedFile = file ?? (features.find(f => f.file === 'features/scenario-approval.desk.yaml') ?? features[0])?.file
  const feature = features.find(f => f.file === selectedFile)
  const state = runner.data?.state
  const result = !state?.stale && (state?.outcome === 'done' || (state?.result?.totals.failed ?? 0) > 0) ? state?.result : null
  const process = feature ? processReading(feature.file) : undefined
  return <>
    <header className="head rules-head">
      <p className="eyebrow">Действующие правила</p>
      <h1>{process?.title ?? feature?.name ?? 'Правила продукта'}</h1>
      <p>Поведение текущей реализации. Предложения изменений и история миграции находятся в отдельных разделах.</p>
      {feature?.description ? <p className="rules-meta">{feature.description}</p> : null}
      <label className="rules-select">Процесс
        <select value={selectedFile ?? ''} onChange={e => onSelect({ kind: 'rules', wt, file: e.target.value })}>
          {features.map(f => <option key={f.file} value={f.file}>{processReading(f.file)?.title ?? f.name} ({f.scenarios.length})</option>)}
        </select>
      </label>
      {feature ? <p className="rules-meta">{ruleCount(feature.scenarios.length)} · {process?.summary ?? feature.file}</p> : null}
      <p className="rules-meta">{state?.stale ? 'Код изменился после последней проверки. Результат требует обновления.' : result ? 'Показаны результаты последней завершенной проверки.' : 'Актуального результата проверки нет.'} Проверка и согласование владельцем учитываются отдельно.</p>
      {state ? <button className="btn" disabled={run.isPending || state.running || state.queued} onClick={() => run.mutate()}>{state.running || state.queued ? 'Проверка выполняется...' : 'Проверить правила'}</button> : null}
      {run.error || state?.error ? <p className="banner bad">{run.error?.message ?? state?.error}</p> : null}
    </header>
    <div className="tabpanel">
      {errors.map(error => <p key={error.file} className="banner bad">{error.file}: {error.message}</p>)}
      {!feature ? <p className="empty">{file ? 'Этот процесс не найден в действующих правилах.' : 'В этом проекте пока нет действующих правил.'}</p> : feature.scenarios.map(s => {
        const run = result?.scenarios[s.key]
        return <article key={s.key} className="rule-card">
          <header><h2>{s.reading?.title ?? s.title}</h2>
            <span className={`pill${run?.status === 'passed' ? ' r-passed' : run?.status === 'failed' ? ' r-failed' : ''}`}>{run?.status === 'passed' ? 'Проверка пройдена' : run?.status === 'failed' ? 'Проверка не пройдена' : 'Нет актуальной проверки'}</span>
          </header>
          {s.reading ? <ContractReading reading={s.reading} /> : <p className="rules-meta">Читаемое представление этого процесса пока не подготовлено. Полное правило доступно в подробностях.</p>}
          {run?.failure ? <pre className="fail">{run.failure.message}</pre> : null}
          <ContractDetails scenario={s} />
        </article>
      })}
    </div>
  </>
}
